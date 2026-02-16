import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const boolFromString = z.preprocess((value) => {
	if (typeof value !== "string") return value;

	if (value.toLowerCase() === "true") return true;
	if (value.toLowerCase() === "false") return false;

	return value;
}, z.boolean());

const configSchema = z.object({
	SERVER_ENDPOINT: z.string(),
	SERVER_IP: z.string(),

	IS_SPECTATOR: boolFromString.default(false),

	LICENSE_IDENTIFIERS: z.string(),

	PORT: z.coerce.number().int().default(3000)
});

export default configSchema.parse(process.env);
