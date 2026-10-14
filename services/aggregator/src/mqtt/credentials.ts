import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const credentialsSchema = z.strictObject({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

export type MqttCredentials = z.infer<typeof credentialsSchema>;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isPermissionError(error: unknown): boolean {
  return errorCode(error) === "EACCES" || errorCode(error) === "EPERM";
}

/**
 * Reads publisher credentials without logging their contents. The file must
 * be a regular file with no group/other POSIX permission bits.
 */
export async function readMqttCredentials(
  path: string | undefined,
): Promise<MqttCredentials> {
  if (!path) throw Error("mqtt_credentials_required");
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw Error(
      isPermissionError(error)
        ? "mqtt_credentials_permissions"
        : "mqtt_credentials_unavailable",
    );
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw Error("mqtt_credentials_permissions");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw Error(
      isPermissionError(error)
        ? "mqtt_credentials_permissions"
        : "mqtt_credentials_unavailable",
    );
  }
  try {
    return credentialsSchema.parse(JSON.parse(contents));
  } catch {
    throw Error("mqtt_credentials_invalid");
  }
}
