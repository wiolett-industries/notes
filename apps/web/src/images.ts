import { t } from './locale';
// Re-encode locally: no uploads, external URLs, SVG markup or EXIF in a note.
export async function readImage(file: File) {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) throw new Error(t("Выберите PNG, JPEG, WebP, GIF или AVIF."));
  if (file.size > 20_000_000) throw new Error(t("Изображение должно быть меньше 20 МБ."));
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(t("Не удалось обработать изображение.")); });
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t("Не удалось обработать изображение."));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // toDataURL synchronously encodes the entire bitmap on the UI thread.
    // Let the browser encode asynchronously, then read the bounded result.
    async function encode(quality: number): Promise<string> {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(t('Не удалось обработать изображение.'))), 'image/webp', quality));
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t('Не удалось обработать изображение.')));
        reader.readAsDataURL(blob);
      });
    }
    let image = await encode(.85);
    if (image.length > 4_000_000) image = await encode(.65);
    if (image.length > 4_000_000) throw new Error(t("Изображение слишком большое после сжатия."));
    return { image, ratio: canvas.width / canvas.height };
  } finally { bitmap.close(); }
}
