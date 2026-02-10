import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { imageFromFile, imageFromBase64, imageFromURL } from "./index.js";

describe("Image helpers", () => {
  describe("imageFromFile", () => {
    test("reads PNG file and returns correct structure", () => {
      // Create a temp PNG file (1x1 red pixel)
      const pngData = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      );
      const tempPath = join(import.meta.dir, "test-image.png");
      writeFileSync(tempPath, pngData);

      try {
        const result = imageFromFile(tempPath);

        expect(result.type).toBe("image");
        expect(result.source.type).toBe("base64");
        expect(result.source.media_type).toBe("image/png");
        expect(typeof result.source.data).toBe("string");
        expect(result.source.data.length).toBeGreaterThan(0);
      } finally {
        unlinkSync(tempPath);
      }
    });

    test("detects JPEG from extension", () => {
      const jpegData = Buffer.from("/9j/4AAQSkZJRg==", "base64");
      const tempPath = join(import.meta.dir, "test-image.jpg");
      writeFileSync(tempPath, jpegData);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/jpeg");
      } finally {
        unlinkSync(tempPath);
      }
    });

    test("detects GIF from extension", () => {
      const gifData = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
      const tempPath = join(import.meta.dir, "test-image.gif");
      writeFileSync(tempPath, gifData);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/gif");
      } finally {
        unlinkSync(tempPath);
      }
    });

    test("detects WebP from extension", () => {
      const webpData = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64");
      const tempPath = join(import.meta.dir, "test-image.webp");
      writeFileSync(tempPath, webpData);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/webp");
      } finally {
        unlinkSync(tempPath);
      }
    });

    test("defaults to JPEG for unknown extensions", () => {
      const data = Buffer.from("test data");
      const tempPath = join(import.meta.dir, "test-image.unknown");
      writeFileSync(tempPath, data);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/jpeg");
      } finally {
        unlinkSync(tempPath);
      }
    });
  });

  describe("imageFromBase64", () => {
    test("wraps base64 data with default PNG type", () => {
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      
      const result = imageFromBase64(data);

      expect(result.type).toBe("image");
      expect(result.source.type).toBe("base64");
      expect(result.source.media_type).toBe("image/png");
      expect(result.source.data).toBe(data);
    });

    test("uses specified media type", () => {
      const data = "somebase64data";
      
      const result = imageFromBase64(data, "image/jpeg");

      expect(result.source.media_type).toBe("image/jpeg");
    });

    test("accepts all valid media types", () => {
      const types = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
      
      for (const mediaType of types) {
        const result = imageFromBase64("data", mediaType);
        expect(result.source.media_type).toBe(mediaType);
      }
    });
  });

  describe("imageFromFile edge cases", () => {
    test("throws on missing file", () => {
      expect(() => imageFromFile("/nonexistent/path/image.png")).toThrow();
    });

    test("handles .jpeg extension", () => {
      const data = Buffer.from("/9j/4AAQSkZJRg==", "base64");
      const tempPath = join(import.meta.dir, "test-image.jpeg");
      writeFileSync(tempPath, data);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/jpeg");
      } finally {
        unlinkSync(tempPath);
      }
    });

    test("handles uppercase .PNG extension", () => {
      const pngData = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      );
      const tempPath = join(import.meta.dir, "test-IMAGE.PNG");
      writeFileSync(tempPath, pngData);

      try {
        const result = imageFromFile(tempPath);
        expect(result.source.media_type).toBe("image/png");
      } finally {
        unlinkSync(tempPath);
      }
    });
  });

  describe("imageFromURL", () => {
    // Mock fetch for URL tests
    const originalFetch = globalThis.fetch;
    
    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    test("fetches image and converts to base64", async () => {
      const mockImageData = Buffer.from("fake image data");
      
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => mockImageData.buffer,
        headers: new Headers({ "content-type": "image/png" }),
      })) as any;

      const result = await imageFromURL("https://example.com/image.png");
      
      expect(result.type).toBe("image");
      expect(result.source.type).toBe("base64");
      expect(result.source.data).toBe(mockImageData.toString("base64"));
    });

    test("detects PNG from content-type header", async () => {
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers({ "content-type": "image/png" }),
      })) as any;

      const result = await imageFromURL("https://example.com/file");
      expect(result.source.media_type).toBe("image/png");
    });

    test("detects JPEG from content-type header", async () => {
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers({ "content-type": "image/jpeg" }),
      })) as any;

      const result = await imageFromURL("https://example.com/file");
      expect(result.source.media_type).toBe("image/jpeg");
    });

    test("detects GIF from URL extension when no content-type", async () => {
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
      })) as any;

      const result = await imageFromURL("https://example.com/animation.gif");
      expect(result.source.media_type).toBe("image/gif");
    });

    test("detects WebP from URL extension", async () => {
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
      })) as any;

      const result = await imageFromURL("https://example.com/photo.webp");
      expect(result.source.media_type).toBe("image/webp");
    });

    test("defaults to PNG when no type info available", async () => {
      globalThis.fetch = mock(async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
      })) as any;

      const result = await imageFromURL("https://example.com/unknown");
      expect(result.source.media_type).toBe("image/png");
    });
  });
});
