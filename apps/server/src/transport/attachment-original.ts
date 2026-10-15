import { z } from "zod";

/**
 * What arrival made of an image original: the normalized copy's ref, or the
 * placeholder it stands for. Holds no file name — the label and placeholder
 * take it from the inbound block. See design/transport/attachments.md →
 * Original records.
 */
export const NormalizedImageResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      path: z.string().min(1),
      mediaType: z.enum(["image/jpeg", "image/png"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("placeholder"),
      reason: z.enum(["undecodable", "too_large", "decode_crashed"]),
    })
    .strict(),
]);
export type NormalizedImageResult = z.infer<typeof NormalizedImageResultSchema>;

/**
 * A record no attempt is decoding, with its state's data: what arrival
 * reuses, or the provider's refusal.
 */
export type FinishedOriginal =
  | { state: "ready"; result: NormalizedImageResult }
  | { state: "rejected" };
