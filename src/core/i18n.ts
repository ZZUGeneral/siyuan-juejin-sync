/**
 * i18n bundle loader.
 *
 * The SiYuan host injects `plugin.i18n` from the `i18n/` folder shipped in `dist/`.
 * We additionally merge our own compiled bundles so that:
 *   1. a key missing from the host bundle still resolves (never render a raw key),
 *   2. a missing translation falls back to Chinese with a console warning (PRD G-01).
 */
import enUS from "../i18n/en_US.json";
import zhCN from "../i18n/zh_CN.json";
import type { I18nBundle, I18nKey } from "../types";

const LOG_SCOPE = "[juejin-sync][i18n]";

const ZH: I18nBundle = zhCN as I18nBundle;
const EN: I18nBundle = enUS as I18nBundle;

export type Lang = "zh_CN" | "en_US";

/**
 * Resolve the active language from the SiYuan client, defaulting to Chinese
 * (PRD G-01: "跟随思源客户端语言；无法判定时回落 zh_CN").
 */
export function detectLang(): Lang {
    try {
        if (typeof window === "undefined") {
            return "zh_CN";
        }
        const raw = window.siyuan?.config?.lang ?? "";
        if (typeof raw === "string" && raw.toLowerCase().startsWith("en")) {
            return "en_US";
        }
        return "zh_CN";
    } catch {
        return "zh_CN";
    }
}

/**
 * Build the effective bundle for the current language.
 *
 * @param hostBundle Bundle injected by the SiYuan host (`plugin.i18n`), optional.
 * @returns A flat `Record<string, string>` keyed by i18n key.
 */
export function createI18n(hostBundle?: I18nBundle): I18nBundle {
    const lang = detectLang();
    const active: I18nBundle = lang === "en_US" ? EN : ZH;
    const missing = Object.keys(ZH).filter((key) => !(key in active));
    if (missing.length > 0) {
        // A single warning is enough — listing 150 keys would flood the console.
        console.warn(`${LOG_SCOPE} ${lang} is missing ${missing.length} key(s), falling back to zh_CN: ${missing.slice(0, 10).join(", ")}`);
    }
    // Host bundle first (it may be localized for an unsupported language),
    // then the reference bundle, then the active language last so it always wins.
    return { ...ZH, ...(hostBundle ?? {}), ...active };
}

/**
 * Interpolate `${name}` style placeholders.
 *
 * @param template Raw template string.
 * @param vars Values to substitute; missing values are replaced with an empty string.
 */
export function formatText(template: string, vars?: Record<string, string | number>): string {
    if (!vars) {
        return template;
    }
    return template.replace(/\$\{(\w+)\}/g, (_match: string, name: string) => {
        const value = vars[name];
        return value === undefined || value === null ? "" : String(value);
    });
}

/**
 * Read a key from a bundle with interpolation, never throwing on a missing key.
 *
 * @param bundle Bundle produced by {@link createI18n}.
 * @param key i18n key, e.g. `"sync.dialog.title"`.
 * @param vars Optional interpolation values.
 */
export function textOf(bundle: I18nBundle, key: I18nKey | string, vars?: Record<string, string | number>): string {
    const template = bundle[key] ?? ZH[key] ?? key;
    return formatText(template, vars);
}

/**
 * Assert (at runtime, once) that both bundles expose exactly the same key set.
 *
 * @returns The symmetric difference between `zh_CN` and `en_US`.
 */
export function findI18nKeyDiff(): string[] {
    const zhKeys = Object.keys(ZH);
    const enKeys = Object.keys(EN);
    const onlyZh = zhKeys.filter((key) => !(key in EN));
    const onlyEn = enKeys.filter((key) => !(key in ZH));
    return [...onlyZh, ...onlyEn];
}
