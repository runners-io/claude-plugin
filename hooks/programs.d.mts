type Env = Record<string, string | undefined>;

/**
 * The absolute path of the program `name` (a bare name such as gh or git) from PATH's absolute folders, or null. The
 * working folder is never looked in. `isProgram` is the tests' seam.
 */
export function findProgram(name: string, env?: Env, platform?: string, isProgram?: (file: string, win: boolean) => boolean): string | null;
