// D-009: 印刷所プロファイルは非公式の目安。出典と確認日を必ず持たせる。
import { describe, expect, it } from 'vitest';
import { PRINT_MESSAGES } from '../../src/print/messages.ts';
import { PROFILES } from '../../src/print/profiles.ts';

describe('印刷所プロファイル', () => {
  it.each(PROFILES.map((p) => [p.id, p]))('%s: 値が妥当な範囲にある', (_, p) => {
    expect(p.bleedMm).toBeGreaterThanOrEqual(2);
    expect(p.bleedMm).toBeLessThanOrEqual(5);
    expect(p.safeMarginMm).toBeGreaterThanOrEqual(2);
    expect(p.safeMarginMm).toBeLessThanOrEqual(10);
    expect(p.recommendedDpi).toBeGreaterThanOrEqual(200);
    expect(p.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('汎用以外のプロファイルは「非公式」と表示し、出典(URL と引用)を持つ', () => {
    for (const p of PROFILES.filter((x) => x.id !== 'generic')) {
      expect(p.label).toContain('非公式');
      expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) {
        expect(s.url).toMatch(/^https:\/\//);
        expect(s.quote.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('入稿チェックの説明文', () => {
  it('すべての理由コードに、題名・理由・直し方がある', () => {
    for (const [code, m] of Object.entries(PRINT_MESSAGES)) {
      expect(m.title, code).not.toBe('');
      expect(m.why, code).not.toBe('');
      expect(m.fix, code).not.toBe('');
    }
  });
});
