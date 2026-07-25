import { z } from "zod";

/** Usernames: 3–20 chars, Latin/Georgian letters, digits, underscore. */
export const usernameSchema = z
  .string()
  .min(3, "At least 3 characters")
  .max(20, "At most 20 characters")
  .regex(/^[a-zA-Z0-9_Ⴀ-ჿ]+$/, "Letters, digits and _ only");

export const registerSchema = z.object({
  email: z.email("Enter a valid email"),
  username: usernameSchema,
  password: z.string().min(8, "At least 8 characters").max(200),
  referralCode: z.string().trim().max(16).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().min(1, "Email or username"),
  password: z.string().min(1, "Password required"),
});

export const limitsSchema = z.object({
  dailyDepositLimitLari: z.number().int().min(0).max(100000).nullable(),
});

export const selfExcludeSchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});
