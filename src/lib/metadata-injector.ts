/**
 * Helper to escape XML special characters
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Standard CRC-32 implementation for PNG chunks
 */
const crcTable: number[] = (() => {
  const table: number[] = [];
  let c: number;
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c;
  }
  return table;
})();

function calculateCRC(bytes: Uint8Array): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * Creates a PNG chunk with the given type and data bytes
 */
function createPNGChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type); // always 4 bytes
  const chunkBytes = new Uint8Array(4 + data.length);
  chunkBytes.set(typeBytes, 0);
  chunkBytes.set(data, 4);

  const crc = calculateCRC(chunkBytes);

  const result = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length, false); // Length BE
  result.set(chunkBytes, 4); // Type + Data
  view.setUint32(8 + data.length, crc, false); // CRC BE
  return result;
}

/**
 * Creates a PNG tEXt chunk
 */
function createPngTextChunk(keyword: string, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const keywordBytes = encoder.encode(keyword);
  const textBytes = encoder.encode(text);
  
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data.set([0], keywordBytes.length); // Null terminator
  data.set(textBytes, keywordBytes.length + 1);
  
  return createPNGChunk('tEXt', data);
}

/**
 * Injects prompt metadata into PNG ArrayBuffer right after IHDR chunk
 */
export function injectMetadataIntoPng(arrayBuffer: ArrayBuffer, prompt: string): ArrayBuffer {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  
  // Verify PNG signature (89 50 4E 47 0D 0A 1A 0A)
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47) {
    console.warn('[MetadataInjector] Not a valid PNG file.');
    return arrayBuffer;
  }
  
  // IHDR is the first chunk, which starts at offset 8.
  const ihdrLength = view.getUint32(8, false);
  const ihdrType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  
  if (ihdrType !== 'IHDR') {
    console.warn('[MetadataInjector] First chunk is not IHDR.');
    return arrayBuffer;
  }
  
  const insertOffset = 8 + 4 + 4 + ihdrLength + 4; // After IHDR
  
  // Create PNG tEXt chunks for both 'parameters' (SD standard) and 'prompt' (general)
  const parametersChunk = createPngTextChunk('parameters', prompt);
  const promptChunk = createPngTextChunk('prompt', prompt);
  
  const newLength = bytes.length + parametersChunk.length + promptChunk.length;
  const newBytes = new Uint8Array(newLength);
  
  newBytes.set(bytes.subarray(0, insertOffset), 0);
  newBytes.set(parametersChunk, insertOffset);
  newBytes.set(promptChunk, insertOffset + parametersChunk.length);
  newBytes.set(bytes.subarray(insertOffset), insertOffset + parametersChunk.length + promptChunk.length);
  
  return newBytes.buffer;
}

/**
 * Creates an APP1 XMP segment for JPEG
 */
function createJpegXmpSegment(prompt: string): Uint8Array {
  const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <dc:description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escapeXml(prompt)}</rdf:li>
    </rdf:Alt>
   </dc:description>
   <xmp:UserComment>${escapeXml(prompt)}</xmp:UserComment>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  const encoder = new TextEncoder();
  const xmlBytes = encoder.encode(xml);
  
  // 'http://ns.adobe.com/xap/1.0/\0' signature (29 bytes)
  const sigBytes = new Uint8Array(29);
  encoder.encodeInto('http://ns.adobe.com/xap/1.0/', sigBytes);
  sigBytes[28] = 0; // Null-terminator

  const payloadLength = 2 + sigBytes.length + xmlBytes.length;
  
  const segment = new Uint8Array(2 + payloadLength);
  segment[0] = 0xFF;
  segment[1] = 0xE1; // APP1
  
  const view = new DataView(segment.buffer);
  view.setUint16(2, payloadLength, false); // Length BE
  
  segment.set(sigBytes, 4);
  segment.set(xmlBytes, 4 + sigBytes.length);
  
  return segment;
}

/**
 * Creates a COM (Comment) segment for JPEG
 */
function createJpegComSegment(prompt: string): Uint8Array {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(prompt);
  const payloadLength = 2 + textBytes.length;
  
  const segment = new Uint8Array(2 + payloadLength);
  segment[0] = 0xFF;
  segment[1] = 0xFE; // COM
  
  const view = new DataView(segment.buffer);
  view.setUint16(2, payloadLength, false); // Length BE
  
  segment.set(textBytes, 4);
  return segment;
}

/**
 * Injects prompt metadata into JPEG/JPG ArrayBuffer right after SOI (Start of Image)
 */
export function injectMetadataIntoJpeg(arrayBuffer: ArrayBuffer, prompt: string): ArrayBuffer {
  const bytes = new Uint8Array(arrayBuffer);
  
  // Verify JPEG SOI marker (FF D8)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    console.warn('[MetadataInjector] Not a valid JPEG file.');
    return arrayBuffer;
  }
  
  const xmpSegment = createJpegXmpSegment(prompt);
  const comSegment = createJpegComSegment(prompt);
  
  const newLength = bytes.length + xmpSegment.length + comSegment.length;
  const newBytes = new Uint8Array(newLength);
  
  newBytes.set(bytes.subarray(0, 2), 0); // SOI (FF D8)
  newBytes.set(xmpSegment, 2); // Insert APP1 (XMP)
  newBytes.set(comSegment, 2 + xmpSegment.length); // Insert COM
  newBytes.set(bytes.subarray(2), 2 + xmpSegment.length + comSegment.length); // The rest
  
  return newBytes.buffer;
}

/**
 * Injects prompt as metadata inside PNG or JPEG files using robust binary magic-byte signatures
 */
export async function injectPromptIntoImage(file: File, prompt: string): Promise<File> {
  if (!prompt || !prompt.trim()) {
    return file;
  }

  try {
    // Highly compatible ArrayBuffer reader with FileReader fallback for older/mobile browsers
    let buffer: ArrayBuffer;
    if (typeof file.arrayBuffer === 'function') {
      buffer = await file.arrayBuffer();
    } else {
      buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (reader.result instanceof ArrayBuffer) {
            resolve(reader.result);
          } else {
            reject(new Error('Failed to read as ArrayBuffer'));
          }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
    }

    const bytes = new Uint8Array(buffer);

    // 1. Verify PNG signature: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      console.log('[MetadataInjector] Magic bytes match PNG, injecting metadata:', file.name);
      const modifiedBuffer = injectMetadataIntoPng(buffer, prompt);
      // Ensure the output file name has a .png extension to match its content
      let finalName = file.name;
      if (!finalName.toLowerCase().endsWith('.png')) {
        const dotIdx = finalName.lastIndexOf('.');
        const base = dotIdx !== -1 ? finalName.substring(0, dotIdx) : finalName;
        finalName = `${base}.png`;
      }
      return new File([modifiedBuffer], finalName, { type: 'image/png' });
    }

    // 2. Verify JPEG signature: FF D8
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      console.log('[MetadataInjector] Magic bytes match JPEG, injecting metadata:', file.name);
      const modifiedBuffer = injectMetadataIntoJpeg(buffer, prompt);
      // Ensure the output file name has a .jpg extension to match its content
      let finalName = file.name;
      if (!finalName.toLowerCase().endsWith('.jpg') && !finalName.toLowerCase().endsWith('.jpeg')) {
        const dotIdx = finalName.lastIndexOf('.');
        const base = dotIdx !== -1 ? finalName.substring(0, dotIdx) : finalName;
        finalName = `${base}.jpg`;
      }
      return new File([modifiedBuffer], finalName, { type: 'image/jpeg' });
    }

    console.warn('[MetadataInjector] File bytes do not match PNG or JPEG signature. Skipping injection for:', file.name);
  } catch (e) {
    console.error('[MetadataInjector] Binary metadata injection failed:', e);
  }

  return file;
}
