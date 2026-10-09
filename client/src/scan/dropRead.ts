// Reading a drag-and-drop of card images (desktop: a card image dragged off
// Scryfall or Gatherer, or image files off the disk). A DataTransfer is only
// readable inside the drop event itself, so this pulls everything out at once
// into plain values; identifying them is async and lives in dropIdentify.ts,
// which loads with the drop review sheet instead of with every page.

/** One thing that was dropped: an image file, link hints, or both. */
export interface DropItem {
  /** The image bytes, when the drop carried them (a file off the disk, or a
   *  browser that hands over the dragged image itself). */
  file?: File;
  /** Every URL the drag carried: the link around the image, the image's own
   *  src. A Scryfall image URL names the exact printing. */
  urls: string[];
  /** What to call it in a message: the file name, or the site it came from. */
  label: string;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name);
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** URLs out of a drag's HTML fragment: the image src first, then any link. */
function urlsFromHtml(html: string): string[] {
  if (!html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out: string[] = [];
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src) out.push(src);
    }
    for (const a of doc.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (href) out.push(href);
    }
    return out.filter(isHttpUrl);
  } catch {
    return [];
  }
}

function labelFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'that image';
  }
}

/** Would this drag drop anything we can use? Only the types are readable mid-drag. */
export function dragCarriesCards(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = [...dt.types];
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
}

/** Everything usable in a drop, one item per card. */
export function readDrop(dt: DataTransfer): DropItem[] {
  const files = [...dt.files].filter(isImageFile);
  const urls = [
    ...dt
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#')),
    dt.getData('text/plain').trim(),
    ...urlsFromHtml(dt.getData('text/html')),
  ].filter(isHttpUrl);
  const unique = [...new Set(urls)];

  // Several files: a folder of scans or a multi-select off the disk. The links
  // a drag carries belong to a single dragged image, so they can't be split
  // across files.
  if (files.length > 1) return files.map((file) => ({ file, urls: [], label: file.name }));
  if (files.length === 1) {
    const file = files[0]!;
    return [{ file, urls: unique, label: unique[0] ? labelFor(unique[0]) : file.name }];
  }
  return unique.length ? [{ urls: unique, label: labelFor(unique[0]!) }] : [];
}
