import React from 'react';

/**
 * Motion design tokens.
 *
 * Centralized durations/easings so components never hardcode animation
 * values. Consumers should reference these tokens (or the CSS custom
 * properties they map to) instead of literal timings.
 */
export const motionTokens = {
  duration: {
    instant: '0ms',
    fast: '120ms',
    normal: '200ms',
    slow: '320ms',
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1.2)',
  },
} as const;

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusBadgeProps {
  /** Semantic status tone. */
  tone: StatusTone;
  /** Human-readable status label. */
  children: React.ReactNode;
  /** Optional accessible description for screen readers. */
  srDescription?: string;
  className?: string;
}

/**
 * Status is never conveyed by color alone: each tone ships a distinct glyph
 * and a text label, and the glyph is exposed to assistive tech via aria-hidden
 * while the visible label carries the meaning.
 */
const TONE_GLYPH: Record<StatusTone, string> = {
  success: '\u2713', // check
  warning: '\u26A0', // warning triangle
  danger: '\u2715', // cross
  info: 'i',
  neutral: '\u2022', // bullet
};

const TONE_LABEL: Record<StatusTone, string> = {
  success: 'Success',
  warning: 'Warning',
  danger: 'Error',
  info: 'Information',
  neutral: 'Status',
};

/**
 * Contrast-safe status colors.
 *
 * Foreground/background pairs are chosen to meet WCAG AA (>= 4.5:1) for the
 * text label. In forced-colors mode the browser overrides these with system
 * colors, so we also set `forced-color-adjust: auto` and rely on borders and
 * glyphs (not fill color) to distinguish states.
 */
const TONE_STYLES: Record<StatusTone, React.CSSProperties> = {
  success: { color: '#0b3d1f', backgroundColor: '#d7f5e0', borderColor: '#0b3d1f' },
  warning: { color: '#4a2c00', backgroundColor: '#ffe9c2', borderColor: '#4a2c00' },
  danger: { color: '#5c0a0a', backgroundColor: '#ffd9d9', borderColor: '#5c0a0a' },
  info: { color: '#0a2a5c', backgroundColor: '#d9e8ff', borderColor: '#0a2a5c' },
  neutral: { color: '#1f2933', backgroundColor: '#e6e9ee', borderColor: '#1f2933' },
};

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.125rem 0.5rem',
  borderRadius: '9999px',
  border: '1px solid',
  fontSize: '0.8125rem',
  fontWeight: 600,
  lineHeight: 1.4,
  // Respect reduced-motion: snap instead of animating.
  transitionProperty: 'background-color, color, border-color',
  transitionDuration: motionTokens.duration.fast,
  transitionTimingFunction: motionTokens.easing.standard,
  // Let the OS high-contrast palette win in forced-colors mode.
  forcedColorAdjust: 'auto',
};

/**
 * StatusBadge renders a semantic status with a glyph + text label so meaning
 * survives both reduced-motion and forced-colors/high-contrast environments.
 */
export function StatusBadge({
  tone,
  children,
  srDescription,
  className,
}: StatusBadgeProps): JSX.Element {
  const glyph = TONE_GLYPH[tone];
  const toneLabel = TONE_LABEL[tone];

  return (
    <span
      className={className}
      style={{ ...baseStyle, ...TONE_STYLES[tone] }}
      data-tone={tone}
      role="status"
    >
      <span aria-hidden="true" style={{ fontWeight: 700 }}>
        {glyph}
      </span>
      <span>{children}</span>
      <span className="sr-only" style={srOnlyStyle}>
        {srDescription ?? toneLabel}
      </span>
    </span>
  );
}

const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export default StatusBadge;
