/**
 * Utilities for smart deduplication of posts and board tabs.
 */

export interface CleanedPostText {
  cleanBody: string;
  hashtags: string[];
}

/**
 * Extracts hashtags from a post text and cleans the main body.
 * Extra spaces, tabs, and duplicate line breaks are stripped out.
 * Hashtags are ignored during body text comparison.
 */
export function normalizePostText(text: string): CleanedPostText {
  if (!text) return { cleanBody: '', hashtags: [] };

  // Match hashtags (e.g. #خبر, #صورة_اليوم)
  const hashtagRegex = /#[^\s#]+/g;
  const hashtags = text.match(hashtagRegex) || [];

  // Remove hashtags from text
  const bodyWithoutHashtags = text.replace(hashtagRegex, '');

  // Collapse multiple spaces/tabs into a single space, collapse excess newlines, trim and lowercase
  const cleanBody = bodyWithoutHashtags
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()
    .toLowerCase();

  return { cleanBody, hashtags };
}

/**
 * Calculates a clean simple hash or signature for string comparison.
 */
export function getPostContentHash(text: string): string {
  const { cleanBody } = normalizePostText(text);
  if (!cleanBody) return '';
  
  // Simple fast string hashing algorithm (djb2 style) for quick memory index comparison
  let hash = 5381;
  for (let i = 0; i < cleanBody.length; i++) {
    hash = (hash * 33) ^ cleanBody.charCodeAt(i);
  }
  return (hash >>> 0).toString(16) + '_' + cleanBody.length;
}

/**
 * Normalizes tab / board names for deduplication check.
 */
export function normalizeBoardName(name: string): string {
  if (!name) return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
