import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Feed, FeedSort } from '../lib/api';

const SORT_OPTIONS: FeedSort[] = ['recent', 'popular', 'trending'];
const DEFAULT_SORT: FeedSort = 'recent';
const DEFAULT_TAGS: string[] = [];

function parseSort(value: string | null): FeedSort {
  if (value && (SORT_OPTIONS as string[]).includes(value)) {
    return value as FeedSort;
  }
  return DEFAULT_SORT;
}

function parseTags(value: string | null): string[] {
  if (!value) return DEFAULT_TAGS;
  const tags = value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= 50 && /^[a-z0-9-_]+$/.test(tag));
  return Array.from(new Set(tags));
}

function serializeTags(tags: string[]): string | null {
  return tags.length > 0 ? tags.join(',') : null;
}

export default function Feeds() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sort = useMemo(() => parseSort(searchParams.get('sort')), [searchParams]);
  const tags = useMemo(() => parseTags(searchParams.get('tags')), [searchParams]);

  const updateParams = useCallback(
    (next: { sort?: FeedSort; tags?: string[] }, replace = false) => {
      const params = new URLSearchParams(searchParams);
      const nextSort = next.sort ?? sort;
      const nextTags = next.tags ?? tags;

      if (nextSort === DEFAULT_SORT) {
        params.delete('sort');
      } else {
        params.set('sort', nextSort);
      }

      const serializedTags = serializeTags(nextTags);
      if (serializedTags) {
        params.set('tags', serializedTags);
      } else {
        params.delete('tags');
      }

      setSearchParams(params, { replace });
    },
    [searchParams, setSearchParams, sort, tags],
  );

  const handleSortChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      updateParams({ sort: parseSort(event.target.value) });
    },
    [updateParams],
  );

  const handleTagToggle = useCallback(
    (tag: string) => {
      const normalized = tag.trim().toLowerCase();
      const nextTags = tags.includes(normalized)
        ? tags.filter((t) => t !== normalized)
        : [...tags, normalized];
      updateParams({ tags: nextTags });
    },
    [tags, updateParams],
  );

  const handleClearFilters = useCallback(() => {
    updateParams({ sort: DEFAULT_SORT, tags: DEFAULT_TAGS });
  }, [updateParams]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getFeeds({ sort, tags })
      .then((data) => {
        if (!cancelled) setFeeds(data);
      })
      .catch(() => {
        if (!cancelled) setError('Unable to load feeds. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sort, tags]);

  return (
    <div className="feeds-page">
      <header className="feeds-header">
        <h1>Feeds</h1>
        <div className="feeds-controls">
          <label htmlFor="feed-sort">Sort</label>
          <select id="feed-sort" value={sort} onChange={handleSortChange}>
            {SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {tags.length > 0 && (
            <button type="button" onClick={handleClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </header>

      {tags.length > 0 && (
        <ul className="feeds-active-tags">
          {tags.map((tag) => (
            <li key={tag}>
              <button type="button" onClick={() => handleTagToggle(tag)}>
                {tag} ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {loading && <p>Loading feeds…</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && (
        <ul className="feeds-list">
          {feeds.map((feed) => (
            <li key={feed.id}>
              <h2>{feed.title}</h2>
              {feed.tags?.length > 0 && (
                <ul className="feed-tags">
                  {feed.tags.map((tag) => (
                    <li key={tag}>
                      <button type="button" onClick={() => handleTagToggle(tag)}>
                        {tag}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
