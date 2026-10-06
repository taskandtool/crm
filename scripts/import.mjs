#!/usr/bin/env node
// Runs scripts/import.ts (see run.mjs). --help for usage.
import { run } from "./run.mjs";
run(import.meta.url);
