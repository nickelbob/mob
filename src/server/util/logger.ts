export function createLogger(module: string) {
  function format(...args: unknown[]) {
    const ts = new Date().toISOString().slice(11, 23);
    return [`[${ts}] [${module}]`, ...args] as const;
  }

  return {
    info(...args: unknown[]) {
      console.log(...format(...args));
    },
    warn(...args: unknown[]) {
      console.warn(...format(...args));
    },
    error(...args: unknown[]) {
      console.error(...format(...args));
    },
  };
}
