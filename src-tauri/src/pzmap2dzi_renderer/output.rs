//! Image output and Deep Zoom pyramid utilities.

use fast_image_resize::{PixelType, ResizeOptions, Resizer, images::Image as ResizeImage};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, RgbImage};
use serde_json::Value;
use std::fs::{self, File};
use std::path::Path;

pub(crate) type OutputResult<T> = Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputFormat {
    Png,
    Webp,
    Jpeg,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ImageSaveOptions {
    pub(crate) png_compression_level: Option<u8>,
    pub(crate) jpeg_quality: Option<u8>,
    pub(crate) save_empty_tile: bool,
}

impl ImageSaveOptions {
    pub(crate) fn from_config(config: &Value) -> Self {
        let Some(raw_options) = config
            .get("render_conf")
            .and_then(|value| value.get("image_save_options"))
        else {
            return Self::default();
        };
        let options = raw_options.as_object().cloned().or_else(|| {
            raw_options
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value.as_object().cloned())
        });
        let Some(options) = options else {
            return Self::default();
        };
        let png_compression_level = options
            .get("png")
            .and_then(Value::as_object)
            .and_then(|value| value.get("compress_level"))
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value.min(9)).ok());
        let jpeg_quality = options
            .get("jpg")
            .or_else(|| options.get("jpeg"))
            .and_then(Value::as_object)
            .and_then(|value| value.get("quality"))
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value.clamp(1, 100)).ok());
        let save_empty_tile = config
            .get("save_empty_tile")
            .or_else(|| {
                config
                    .get("render_conf")
                    .and_then(|value| value.get("save_empty_tile"))
            })
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            png_compression_level,
            jpeg_quality,
            save_empty_tile,
        }
    }
}

impl OutputFormat {
    pub(crate) fn from_name(name: Option<&str>) -> Self {
        match name.unwrap_or("webp").to_ascii_lowercase().as_str() {
            "png" => Self::Png,
            "jpg" | "jpeg" => Self::Jpeg,
            _ => Self::Webp,
        }
    }

    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Jpeg => "jpg",
        }
    }

    pub(crate) fn dzi_name(self) -> &'static str {
        self.extension()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RgbaImage {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) pixels: Vec<u8>,
}

impl RgbaImage {
    pub(crate) fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; width.saturating_mul(height).saturating_mul(4)],
        }
    }

    pub(crate) fn set_pixel(&mut self, x: i32, y: i32, color: [u8; 4]) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let index = (y as usize * self.width + x as usize) * 4;
        self.pixels[index..index + 4].copy_from_slice(&color);
    }

    pub(crate) fn blend_pixel(&mut self, x: i32, y: i32, color: [u8; 4]) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let index = (y as usize * self.width + x as usize) * 4;
        let alpha = color[3] as u16;
        let inverse = 255 - alpha;
        let destination_alpha = self.pixels[index + 3] as u16;
        let output_alpha =
            ((alpha as u32 * 255 + destination_alpha as u32 * inverse as u32 + 127) / 255) as u16;
        for channel in 0..3 {
            let numerator = color[channel] as u32 * alpha as u32 * 255
                + self.pixels[index + channel] as u32 * destination_alpha as u32 * inverse as u32;
            let denominator = (output_alpha as u32 * 255).max(1);
            self.pixels[index + channel] =
                ((numerator + denominator / 2) / denominator).min(255) as u8;
        }
        self.pixels[index + 3] = output_alpha as u8;
    }

    pub(crate) fn alpha_composite(&mut self, source: &Self) {
        let width = self.width.min(source.width);
        let height = self.height.min(source.height);
        for y in 0..height {
            for x in 0..width {
                let index = (y * source.width + x) * 4;
                self.blend_pixel(
                    x as i32,
                    y as i32,
                    source.pixels[index..index + 4]
                        .try_into()
                        .expect("RGBA pixels are four bytes"),
                );
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pixels.chunks_exact(4).all(|pixel| pixel[3] == 0)
    }

    pub(crate) fn write(
        &self,
        path: &Path,
        format: OutputFormat,
        options: ImageSaveOptions,
    ) -> OutputResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        match format {
            OutputFormat::Png => {
                let file = File::create(path).map_err(|error| error.to_string())?;
                let compression = options
                    .png_compression_level
                    .map(CompressionType::Level)
                    .unwrap_or_default();
                PngEncoder::new_with_quality(file, compression, PngFilterType::Adaptive)
                    .write_image(
                        &self.pixels,
                        self.width as u32,
                        self.height as u32,
                        ExtendedColorType::Rgba8,
                    )
                    .map_err(|error| error.to_string())
            }
            OutputFormat::Webp => self.write_with_image_crate(path, ImageFormat::WebP),
            OutputFormat::Jpeg => {
                let mut rgb = RgbImage::new(self.width as u32, self.height as u32);
                for (source, target) in self.pixels.chunks_exact(4).zip(rgb.pixels_mut()) {
                    *target = image::Rgb([source[0], source[1], source[2]]);
                }
                let file = File::create(path).map_err(|error| error.to_string())?;
                let quality = options.jpeg_quality.unwrap_or(75);
                JpegEncoder::new_with_quality(file, quality)
                    .write_image(
                        rgb.as_raw(),
                        self.width as u32,
                        self.height as u32,
                        ExtendedColorType::Rgb8,
                    )
                    .map_err(|error| error.to_string())
            }
        }
    }

    fn write_with_image_crate(&self, path: &Path, format: ImageFormat) -> OutputResult<()> {
        let image =
            image::RgbaImage::from_raw(self.width as u32, self.height as u32, self.pixels.clone())
                .ok_or_else(|| "Invalid RGBA image buffer.".to_string())?;
        DynamicImage::ImageRgba8(image)
            .save_with_format(path, format)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn read(path: &Path) -> OutputResult<Self> {
        let decoded = image::open(path)
            .map_err(|error| format!("{}: {error}", path.display()))?
            .to_rgba8();
        Ok(Self {
            width: decoded.width() as usize,
            height: decoded.height() as usize,
            pixels: decoded.into_raw(),
        })
    }

    pub(crate) fn downsample_2x_with(
        self,
        resizer: &mut Resizer,
        options: &ResizeOptions,
    ) -> OutputResult<Self> {
        let width = self.width.div_ceil(2).max(1);
        let height = self.height.div_ceil(2).max(1);

        // Python's Image.thumbnail(..., Image.LANCZOS) is the reference path.
        // fast_image_resize uses the same Lanczos3 convolution family, but
        // dispatches to SIMD implementations for RGBA8 and lets each worker
        // reuse its filter buffers across thousands of tiles.
        let source = ResizeImage::from_vec_u8(
            self.width as u32,
            self.height as u32,
            self.pixels,
            PixelType::U8x4,
        )
        .map_err(|error| format!("Invalid pyramid source image: {error}"))?;
        let mut resized = ResizeImage::new(width as u32, height as u32, PixelType::U8x4);
        resizer
            .resize(&source, &mut resized, Some(options))
            .map_err(|error| format!("Pyramid resize failed: {error}"))?;

        Ok(Self {
            width,
            height,
            pixels: resized.into_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_2x_resizes_rgba8_with_lanczos() {
        let mut source = RgbaImage::new(4, 4);
        for pixel in source.pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[220, 96, 32, 255]);
        }
        let mut resizer = Resizer::new();
        let options = ResizeOptions::new()
            .resize_alg(fast_image_resize::ResizeAlg::Convolution(
                fast_image_resize::FilterType::Lanczos3,
            ))
            .use_alpha(true);

        let result = source
            .downsample_2x_with(&mut resizer, &options)
            .expect("valid RGBA8 image should resize");

        assert_eq!((result.width, result.height), (2, 2));
        assert_eq!(result.pixels.len(), 2 * 2 * 4);
        assert!(result.pixels.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }
}
