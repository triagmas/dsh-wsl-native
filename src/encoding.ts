import { BridgeError } from './errors.js';
import { t } from './i18n/index.js';

/** Encodings supported by the file tools. */
export const FILE_ENCODINGS = ['utf8', 'gb18030', 'base64'] as const;
export type FileEncoding = (typeof FILE_ENCODINGS)[number];

/** One decoded page: exact bytes consumed plus the text that stays on character boundaries. */
export interface DecodedChunk {
  content: string;
  bytes: number;
}

/**
 * Keep paging offsets on character boundaries, including 4-byte GB18030
 * characters, so a page never splits a multi-byte sequence.
 */
export function decodeChunk(data: Buffer, encoding: FileEncoding, eof: boolean): DecodedChunk {
  if (encoding === 'base64') return { content: data.toString('base64'), bytes: data.length };
  let length = data.length;
  if (!eof) {
    let i = 0;
    while (i < data.length) {
      const first = data[i] as number;
      let width = 1;
      if (encoding === 'utf8') {
        width =
          first < 0x80
            ? 1
            : first >= 0xc2 && first <= 0xdf
              ? 2
              : first >= 0xe0 && first <= 0xef
                ? 3
                : first >= 0xf0 && first <= 0xf4
                  ? 4
                  : 1;
      } else if (first >= 0x81 && first <= 0xfe) {
        const second = data[i + 1] as number | undefined;
        width = second !== undefined && second >= 0x30 && second <= 0x39 ? 4 : 2;
      }
      if (i + width > data.length) {
        length = i;
        break;
      }
      i += width;
    }
    if (length === 0 && data.length > 0) {
      throw new BridgeError('LIMIT_TOO_SMALL', t('encoding.limitTooSmall'));
    }
  }
  try {
    return {
      content: new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding, { fatal: true }).decode(
        data.subarray(0, length),
      ),
      bytes: length,
    };
  } catch {
    throw new BridgeError('INVALID_ENCODING', t('encoding.invalid'));
  }
}
