import { open } from "node:fs/promises";
import { constants } from "node:fs";
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
  let handle;
  let contents: string;
  try {
    // POSIX permissions are an explicit backend requirement. Do not silently
    // weaken secret-file checks on platforms that need a different ACL model.
    if (process.platform === "win32")
      throw Object.assign(Error("unsupported_acl"), { code: "EPERM" });
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.mode & 0o077 ||
      (process.getuid && metadata.uid !== process.getuid())
    )
      throw Object.assign(Error("permissions"), { code: "EPERM" });
    if (metadata.size > 16384) throw Error("mqtt_credentials_invalid");
    contents = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "mqtt_credentials_invalid")
      throw error;
    throw Error(
      isPermissionError(error) || errorCode(error) === "ELOOP"
        ? "mqtt_credentials_permissions"
        : "mqtt_credentials_unavailable",
    );
  } finally {
    await handle?.close();
  }
  try {
    return credentialsSchema.parse(JSON.parse(contents));
  } catch {
    throw Error("mqtt_credentials_invalid");
  }
}
