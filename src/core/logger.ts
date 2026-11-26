/**
 * Logging with a single unified prefix and credential masking.
 *
 * Prefix format: `[juejin-sync][<scope>]` (architecture §8.6).
 * Never log a request body (bodies can be megabytes) and never log a clear-text cookie.
 */

export type LogScope =
    | "boot"
    | "settings"
    | "juejin"
    | "images"
    | "markdown"
    | "engine"
    | "import"
    | "ui"
    | "i18n"
    | "kernel"
    | "proxy";

export interface Logger {
    debug(message: string, ...rest: unknown[]): void;
    info(message: string, ...rest: unknown[]): void;
    warn(message: string, ...rest: unknown[]): void;
    error(message: string, ...rest: unknown[]): void;
}

const PREFIX = "[juejin-sync]";

/**
 * Mask any credential-looking fragment in a log line.
 *
 * `sessionid_ss=abc123` → `sessionid_ss=***`, `Token abc` → `Token ***`.
 *
 * @param input Arbitrary text about to be logged.
 */
export function maskSecret(input: string): string {
    if (!input) {
        return "";
    }
    return input
        .replace(/(sessionid_ss|sessionid|SESSIONID|SESSIONID_SS)\s*=\s*[^;\s"']+/g, (_m, name: string) => `${name}=***`)
        .replace(/(Authorization\s*:\s*Token\s+)\S+/gi, (_m, head: string) => `${head}***`)
        .replace(/(x-amz-security-token["']?\s*[:=]\s*["']?)\S+/gi, (_m, head: string) => `${head}***`);
}

/** Deep-mask strings inside a value passed to the logger. */
function maskArgs(args: unknown[]): unknown[] {
    return args.map((arg) => (typeof arg === "string" ? maskSecret(arg) : arg));
}

/**
 * Create a scoped logger.
 *
 * @param scope One of the fixed scopes from architecture §8.6.
 */
export function createLogger(scope: LogScope): Logger {
    const tag = `${PREFIX}[${scope}]`;
    return {
        debug(message: string, ...rest: unknown[]): void {
            console.debug(`${tag} ${maskSecret(message)}`, ...maskArgs(rest));
        },
        info(message: string, ...rest: unknown[]): void {
            console.info(`${tag} ${maskSecret(message)}`, ...maskArgs(rest));
        },
        warn(message: string, ...rest: unknown[]): void {
            console.warn(`${tag} ${maskSecret(message)}`, ...maskArgs(rest));
        },
        error(message: string, ...rest: unknown[]): void {
            console.error(`${tag} ${maskSecret(message)}`, ...maskArgs(rest));
        },
    };
}
