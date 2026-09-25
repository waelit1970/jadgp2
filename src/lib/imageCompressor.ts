/**
 * Smart Client-Side Image Compressor & URL Downloader
 * Compresses images while preserving 100% original dimensions (exact width & height)
 * and indistinguishable visual quality to the human eye, reducing 2MB–5MB photos down to ~250KB–350KB.
 */

export interface SmartCompressOptions {
  quality?: number; // Default 0.85 (sweet spot for high fidelity + lightweight size)
  maxSizeToSkip?: number; // Skip files already smaller than e.g. 120KB
}

/**
 * Compresses a File or Blob preserving 100% natural resolution (zero dimension downsizing)
 */
export async function smartCompressImage(
  file: File | Blob,
  fileName = 'image.jpg',
  options: SmartCompressOptions = {}
): Promise<File> {
  const { quality = 0.85, maxSizeToSkip = 120 * 1024 } = options;

  const type = file.type || 'image/jpeg';

  // Do not compress non-images, animated GIFs, or SVGs
  if (type === 'image/gif' || type === 'image/svg+xml' || (!type.startsWith('image/') && !type.includes('octet-stream'))) {
    if (file instanceof File) return file;
    return new File([file], fileName, { type });
  }

  // If already featherlight, keep original
  if (file.size > 0 && file.size <= maxSizeToSkip) {
    if (file instanceof File) return file;
    return new File([file], fileName, { type });
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;

        if (!width || !height) {
          if (file instanceof File) return resolve(file);
          return resolve(new File([file], fileName, { type }));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d', { willReadFrequently: false });
        if (!ctx) {
          if (file instanceof File) return resolve(file);
          return resolve(new File([file], fileName, { type }));
        }

        // Draw image at 100% original dimensions
        ctx.drawImage(img, 0, 0, width, height);

        // Determine best format: JPEG or WebP
        const isPng = type === 'image/png';
        const exportType = isPng ? 'image/jpeg' : (type === 'image/webp' ? 'image/webp' : 'image/jpeg');

        canvas.toBlob(
          (blob) => {
            if (!blob || blob.size === 0) {
              if (file instanceof File) return resolve(file);
              return resolve(new File([file], fileName, { type }));
            }

            // Only use compressed if it actually reduced the size
            if (blob.size < file.size) {
              const cleanName = fileName.replace(/\.(png|jpeg|webp|bmp|tiff)$/i, '') + (exportType === 'image/webp' ? '.webp' : '.jpg');
              const compressedFile = new File([blob], cleanName, { type: exportType });
              console.log(`[SmartCompress] Compressed ${(file.size / 1024).toFixed(1)}KB -> ${(blob.size / 1024).toFixed(1)}KB (${width}x${height} px unchanged)`);
              resolve(compressedFile);
            } else {
              if (file instanceof File) return resolve(file);
              resolve(new File([file], fileName, { type }));
            }
          },
          exportType,
          quality
        );
      } catch (err) {
        console.warn('[SmartCompress] Error in canvas compression, using original:', err);
        if (file instanceof File) return resolve(file);
        resolve(new File([file], fileName, { type }));
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (file instanceof File) return resolve(file);
      resolve(new File([file], fileName, { type }));
    };

    img.src = objectUrl;
  });
}

/**
 * Legacy Base64 compressor (preserves compatibility with legacy call sites)
 */
export async function compressImage(file: File, maxDimension = 1024, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    img.onload = () => {
      try {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      } catch (e) {
        reject(e);
      }
    };

    img.onerror = (err) => reject(err);

    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string;
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getBackendBaseUrl(): string {
  const isNetlify = typeof window !== 'undefined' && window.location.hostname.includes('netlify');
  const isStaticHost =
    typeof window !== 'undefined' &&
    !isNetlify &&
    (window.location.hostname.includes('workers.dev') ||
      window.location.hostname.includes('pages.dev') ||
      window.location.hostname.includes('github') ||
      window.location.hostname.includes('vercel') ||
      (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app')));

  return isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';
}

/**
 * Downloads an image from any external URL, passes through proxy if needed,
 * and smart-compresses it keeping 100% original dimensions.
 */
export async function downloadAndSmartCompressImageFromUrl(imageUrl: string): Promise<File | null> {
  if (!imageUrl) return null;

  try {
    const isNetlify = typeof window !== 'undefined' && window.location.hostname.includes('netlify.app');
    const baseUrl = getBackendBaseUrl();
    const downloadEndpoint = isNetlify
      ? `/.netlify/functions/download?url=${encodeURIComponent(imageUrl)}`
      : `${baseUrl}/api/download?url=${encodeURIComponent(imageUrl)}`;

    let blob: Blob | null = null;
    try {
      const res = await fetch(downloadEndpoint);
      if (res.ok) {
        const fetchedBlob = await res.blob();
        if (fetchedBlob && fetchedBlob.size > 0) {
          blob = fetchedBlob;
        }
      }
    } catch (e) {
      console.warn('[DownloadImage] Proxy fetch failed, attempting direct fetch:', e);
    }

    if (!blob || blob.size === 0) {
      try {
        const directRes = await fetch(imageUrl, { mode: 'cors' });
        if (directRes.ok) {
          const directBlob = await directRes.blob();
          if (directBlob && directBlob.size > 0) {
            blob = directBlob;
          }
        }
      } catch (e) {
        console.warn('[DownloadImage] Direct fetch failed:', e);
      }
    }

    // Secondary fallback: Try loading into an Image element and drawing onto a Canvas
    if (!blob || blob.size === 0) {
      try {
        blob = await new Promise<Blob | null>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth || img.width;
              canvas.height = img.naturalHeight || img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) return resolve(null);
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.95);
            } catch (err) {
              resolve(null);
            }
          };
          img.onerror = () => resolve(null);
          img.src = imageUrl;
        });
      } catch (canvasErr) {
        console.warn('[DownloadImage] Canvas conversion fallback failed:', canvasErr);
      }
    }

    if (!blob || blob.size === 0) return null;

    const mimeType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
    let extension = 'jpg';
    if (mimeType.includes('png')) extension = 'png';
    else if (mimeType.includes('webp')) extension = 'webp';
    else if (mimeType.includes('gif')) extension = 'gif';

    const rawFileName = `image_${Date.now()}.${extension}`;
    const rawFile = new File([blob], rawFileName, { type: mimeType });

    // Apply smart compression with 100% dimension preservation
    const compressedFile = await smartCompressImage(rawFile, rawFileName);
    return compressedFile;
  } catch (err) {
    console.error('[DownloadImage] Fatal error:', err);
    return null;
  }
}

/**
 * Extracts and separates image URLs from text
 */
export function extractImageUrlsFromText(inputText: string): {
  foundUrls: string[];
  cleanText: string;
} {
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const matches = inputText.match(urlRegex);
  if (!matches) {
    return { foundUrls: [], cleanText: inputText };
  }

  const foundUrls: string[] = [];
  let cleanText = inputText;

  for (const match of matches) {
    const href = match.toLowerCase().startsWith('www.') ? `https://${match}` : match;
    const cleanUrl = href.split('?')[0].split('#')[0];

    // Detect image extensions or Meta / CDN / photo patterns
    const isDirectImg = /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(cleanUrl);
    const isMetaOrCdnImg = /(fbcdn\.net|cdninstagram\.com|instagram\.com\/p\/|facebook\.com\/photo|scontent[^\/]+\.net|imgur\.com|i\.pinimg\.com|images\.unsplash\.com|pbs\.twimg\.com)/i.test(href);

    if (isDirectImg || isMetaOrCdnImg) {
      foundUrls.push(href);
      cleanText = cleanText.replace(match, '').trim();
    }
  }

  return { foundUrls, cleanText };
}
