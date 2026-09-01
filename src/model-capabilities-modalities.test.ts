import { describe, expect, it } from "vitest";
import { normalizeCapabilities, validateModelCapabilities } from "./model-capabilities";

describe("upstream modality capability aliases", () => {
  it("accepts supportedInputModalities and supportedOutputModalities", () => {
    expect(normalizeCapabilities({
      supportedInputModalities: ["TEXT", "image", "video"],
      supportedOutputModalities: ["text"],
    })).toMatchObject({
      inputModalities: ["text", "image", "video"],
      outputModalities: ["text"],
    });
  });

  it("keeps existing local aliases ahead of upstream camelCase aliases", () => {
    expect(normalizeCapabilities({
      inputModalities: ["text"],
      supportedInputModalities: ["text", "image"],
      output_modalities: ["text"],
      supportedOutputModalities: ["image"],
    })).toMatchObject({
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
  });

  it("uses parsed image modality for request capability validation", () => {
    const multimodal = normalizeCapabilities({ supportedInputModalities: ["text", "image", "video"] });
    expect(() => validateModelCapabilities({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] }],
    }, multimodal)).not.toThrow();

    const textOnly = normalizeCapabilities({ supportedInputModalities: ["text"] });
    expect(() => validateModelCapabilities({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] }],
    }, textOnly)).toThrowError(/does not support image input/);
  });
});
