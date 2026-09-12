// Re-encode locally: no uploads, external URLs, SVG markup or EXIF in a note.
export async function readImage(file: File) {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) throw new Error('Выберите PNG, JPEG, WebP, GIF или AVIF.');
  if (file.size > 20_000_000) throw new Error('Изображение должно быть меньше 20 МБ.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let image = canvas.toDataURL('image/webp', .85);
    if (image.length > 4_000_000) image = canvas.toDataURL('image/webp', .65);
    if (image.length > 4_000_000) throw new Error('Изображение слишком большое после сжатия.');
    return { image, ratio: canvas.width / canvas.height };
  } finally { bitmap.close(); }
}
