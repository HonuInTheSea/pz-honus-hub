//! Optional WGPU acceleration for the Deep Zoom pyramid downsample.
//!
//! The native renderer still owns image decoding, cache checks, cancellation,
//! encoding, and file I/O. This module only moves the pixel resize operation to
//! a compute-capable adapter. Keeping that boundary small makes the GPU path
//! safe to disable or fall back to the Rayon implementation when an adapter is
//! unavailable or a tile exceeds the adapter's texture limits.

use super::output::RgbaImage;
use std::borrow::Cow;
use std::num::NonZeroU64;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, OnceLock, mpsc};

const SHADER: &str = r#"
struct Params {
  src_width: u32,
  src_height: u32,
  dst_width: u32,
  dst_height: u32,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var destination_texture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dst_width || id.y >= params.dst_height) {
    return;
  }

  // A pyramid level is exactly a 2x reduction. Linear filtering performs the
  // four-pixel interpolation in hardware and is considerably cheaper than
  // running the full CPU Lanczos filter for every output pixel.
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5, 0.5))
    / vec2<f32>(f32(params.dst_width), f32(params.dst_height));
  let color = textureSampleLevel(source_texture, source_sampler, uv, 0.0);
  textureStore(destination_texture, vec2<i32>(id.xy), color);
}
"#;

pub(crate) struct GpuPyramid {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    adapter_name: String,
    max_texture_dimension_2d: u32,
}

impl GpuPyramid {
    pub(crate) fn shared() -> Result<Arc<Self>, String> {
        static CONTEXT: OnceLock<Result<Arc<GpuPyramid>, String>> = OnceLock::new();
        CONTEXT.get_or_init(|| Self::new().map(Arc::new)).clone()
    }

    pub(crate) fn new() -> Result<Self, String> {
        catch_unwind(AssertUnwindSafe(Self::initialize)).map_err(|payload| {
            format!(
                "GPU pyramid initialization panicked during adapter or shader validation: {}",
                panic_message(payload)
            )
        })?
    }

    fn initialize() -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN | wgpu::Backends::GL,
            ..Default::default()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|error| format!("No compatible GPU adapter was found: {error}"))?;
        let adapter_info = adapter.get_info();
        let max_texture_dimension_2d = adapter.limits().max_texture_dimension_2d;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pzmap2dzi pyramid device"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|error| format!("Could not initialize GPU adapter: {error}"))?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pzmap2dzi pyramid downsample shader"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER)),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pzmap2dzi pyramid bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: NonZeroU64::new(16),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pzmap2dzi pyramid pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("pzmap2dzi pyramid compute pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("pzmap2dzi pyramid linear sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            sampler,
            adapter_name: format!("{} ({:?})", adapter_info.name, adapter_info.backend),
            max_texture_dimension_2d,
        })
    }

    pub(crate) fn adapter_name(&self) -> &str {
        &self.adapter_name
    }

    pub(crate) fn downsample(
        &self,
        source: &RgbaImage,
        width: usize,
        height: usize,
    ) -> Result<RgbaImage, String> {
        catch_unwind(AssertUnwindSafe(|| {
            self.downsample_impl(source, width, height)
        }))
        .map_err(|payload| {
            format!(
                "GPU pyramid processing panicked during command validation: {}",
                panic_message(payload)
            )
        })?
    }

    fn downsample_impl(
        &self,
        source: &RgbaImage,
        width: usize,
        height: usize,
    ) -> Result<RgbaImage, String> {
        let source_width = u32::try_from(source.width)
            .map_err(|_| "GPU pyramid source width is too large.".to_string())?;
        let source_height = u32::try_from(source.height)
            .map_err(|_| "GPU pyramid source height is too large.".to_string())?;
        let output_width = u32::try_from(width)
            .map_err(|_| "GPU pyramid output width is too large.".to_string())?;
        let output_height = u32::try_from(height)
            .map_err(|_| "GPU pyramid output height is too large.".to_string())?;
        if source_width > self.max_texture_dimension_2d
            || source_height > self.max_texture_dimension_2d
            || output_width > self.max_texture_dimension_2d
            || output_height > self.max_texture_dimension_2d
        {
            return Err(format!(
                "GPU pyramid tile exceeds {} texture limit (source {}x{}, output {}x{}).",
                self.max_texture_dimension_2d,
                source_width,
                source_height,
                output_width,
                output_height
            ));
        }

        let source_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pzmap2dzi pyramid source texture"),
            size: wgpu::Extent3d {
                width: source_width.max(1),
                height: source_height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &source_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &source.pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(source_width * 4),
                rows_per_image: Some(source_height),
            },
            wgpu::Extent3d {
                width: source_width,
                height: source_height,
                depth_or_array_layers: 1,
            },
        );

        let destination_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pzmap2dzi pyramid destination texture"),
            size: wgpu::Extent3d {
                width: output_width.max(1),
                height: output_height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let uniform_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pzmap2dzi pyramid parameters"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut params = Vec::with_capacity(16);
        for value in [source_width, source_height, output_width, output_height] {
            params.extend_from_slice(&value.to_ne_bytes());
        }
        self.queue.write_buffer(&uniform_buffer, 0, &params);

        let source_view = source_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let destination_view =
            destination_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pzmap2dzi pyramid bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&source_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&destination_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let bytes_per_row = (output_width as usize * 4)
            .div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pzmap2dzi pyramid readback"),
            size: (bytes_per_row * output_height as usize) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("pzmap2dzi pyramid command encoder"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("pzmap2dzi pyramid downsample pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(output_width.div_ceil(8), output_height.div_ceil(8), 1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &destination_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row as u32),
                    rows_per_image: Some(output_height),
                },
            },
            wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));

        let (sender, receiver) = mpsc::channel();
        staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        self.device
            .poll(wgpu::PollType::wait())
            .map_err(|error| format!("GPU pyramid readback polling failed: {error:?}"))?;
        receiver
            .recv()
            .map_err(|error| format!("GPU pyramid readback callback failed: {error}"))?
            .map_err(|error| format!("GPU pyramid readback failed: {error}"))?;
        let mapped = staging.slice(..).get_mapped_range();
        let mut pixels = vec![0_u8; width.saturating_mul(height).saturating_mul(4)];
        for row in 0..height {
            let source_start = row * bytes_per_row;
            let target_start = row * width * 4;
            pixels[target_start..target_start + width * 4]
                .copy_from_slice(&mapped[source_start..source_start + width * 4]);
        }
        drop(mapped);
        staging.unmap();
        Ok(RgbaImage {
            width,
            height,
            pixels,
        })
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_shader_validation_never_panics_the_worker() {
        let Ok(gpu) = GpuPyramid::new() else {
            // A machine without a usable graphics adapter is a valid CPU-only
            // deployment; the production auto mode handles this as fallback.
            return;
        };
        let source = RgbaImage {
            width: 2,
            height: 2,
            pixels: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ],
        };
        let output = gpu
            .downsample(&source, 1, 1)
            .expect("validated GPU pyramid should process a tiny tile");
        assert_eq!((output.width, output.height), (1, 1));
        assert_eq!(output.pixels.len(), 4);
    }
}
