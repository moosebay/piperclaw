/** Simple logger for the tasks subsystem. Safe to use in tests. */
export const taskLog = {
  info(msg: string): void {
    if (process.env.NODE_ENV !== "test") {
      console.log(`[tasks] ${msg}`);
    }
  },
  warn(msg: string): void {
    console.warn(`[tasks] ${msg}`);
  },
  error(msg: string): void {
    console.error(`[tasks] ${msg}`);
  },
};
