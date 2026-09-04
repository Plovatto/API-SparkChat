export interface LinkPreviewMetadata {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface LinkPreviewCacheRecord {
  url: string;
  status: 'ok' | 'error';
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: string;
}

export interface LinkPreviewFetcher {
  fetchMetadata(url: string): Promise<LinkPreviewMetadata | null>;
}
