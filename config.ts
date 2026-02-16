import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const configSchema = z.object({
	SERVER_ENDPOINT: z.string(),
	SERVER_IP: z.string(),

	IS_SPECTATOR: z.boolean(),

	LICENSE_IDENTIFIERS: z.string(),

	PORT: z.coerce.number().int().default(3000)
});

export default configSchema.parse(process.env);
