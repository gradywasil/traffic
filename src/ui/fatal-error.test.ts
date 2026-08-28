/**
 * fatalErrorMessage tests (harden pass): the pure half of the fatal error
 * surface — unknown-caught errors become bounded, readable text.
 */
import { describe, expect, it } from 'vitest';
import { fatalErrorMessage, MAX_DETAIL_LENGTH } from './fatal-error';

describe('fatalErrorMessage', () => {
  it('uses an Error message', () => {
    expect(fatalErrorMessage(new Error('Canvas 2D context unavailable'))).toBe('Canvas 2D context unavailable');
  });

  it('falls back to the Error name when the message is empty', () => {
    expect(fatalErrorMessage(new Error(''))).toBe('Error');
  });

  it('passes strings through', () => {
    expect(fatalErrorMessage('worker blocked by CSP')).toBe('worker blocked by CSP');
  });

  it('stringifies non-error rejects', () => {
    expect(fatalErrorMessage(42)).toBe('42');
    expect(fatalErrorMessage(null)).toBe('null');
    expect(fatalErrorMessage(undefined)).toBe('undefined');
  });

  it('truncates absurdly long messages to the layout bound with an ellipsis', () => {
    const long = 'x'.repeat(5_000);
    const text = fatalErrorMessage(new Error(long));
    expect(text.length).toBe(MAX_DETAIL_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('x')).toBe(true);
  });

  it('keeps messages at exactly the bound untruncated', () => {
    const exact = 'y'.repeat(MAX_DETAIL_LENGTH);
    expect(fatalErrorMessage(exact)).toBe(exact);
  });
});
