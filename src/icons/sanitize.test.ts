// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeSvg, svgDataUrl } from "./sanitize";

const wrap = (body: string, attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"') => `<svg ${attrs}>${body}</svg>`;

describe("sanitizeSvg", () => {
  it("keeps plain icons, gradients and local references", () => {
    const svg = wrap(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#g)" d="M0 0h16v16H0z"/>',
    );
    const clean = sanitizeSvg(svg);
    expect(clean).toContain("linearGradient");
    expect(clean).toContain('fill="url(#g)"');
  });

  it("removes scripts, handlers and foreign content", () => {
    const clean = sanitizeSvg(
      wrap('<script>alert(1)</script><path onclick="alert(1)" d="M0 0"/><foreignObject><div>x</div></foreignObject><style>@import url(http://x)</style>'),
    );
    expect(clean).not.toBeNull();
    expect(clean).not.toMatch(/script|onclick|foreignObject|style|@import/i);
  });

  it("removes external images and links", () => {
    const clean = sanitizeSvg(wrap('<image href="http://evil/x.png"/><a href="javascript:alert(1)"><path d="M0 0"/></a>'));
    expect(clean ?? "").not.toMatch(/evil|javascript|<image|<a /);
  });

  it("drops <use> (DOMPurify does not allow it) and rejects external url() references", () => {
    expect(sanitizeSvg(wrap('<use href="http://evil/sprite.svg#x"/>')) ?? "").not.toMatch(/evil|<use/);
    expect(sanitizeSvg(wrap('<path fill="url(http://evil/x)" d="M0 0"/>'))).toBeNull();
    expect(sanitizeSvg(wrap('<path style="fill:url(http://evil/x)" d="M0 0"/>'))).toBeNull();
  });

  it("rejects what is not an SVG", () => {
    expect(sanitizeSvg("<div>hi</div>")).toBeNull();
    expect(sanitizeSvg("not markup")).toBeNull();
    expect(sanitizeSvg(wrap("<path/>".repeat(20000)))).toBeNull();
  });

  it("adds the SVG namespace and is idempotent", () => {
    const clean = sanitizeSvg(wrap('<path d="M0 0"/>', 'viewBox="0 0 16 16"'));
    expect(clean).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(sanitizeSvg(clean as string)).toBe(clean);
  });
});

describe("svgDataUrl", () => {
  it("encodes the markup", () => {
    expect(svgDataUrl('<svg a="b"/>')).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22b%22%2F%3E");
  });
});
