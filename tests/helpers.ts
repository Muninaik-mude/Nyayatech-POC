import * as fs from "fs";
import * as path from "path";

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
export const fixture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), "utf8");
