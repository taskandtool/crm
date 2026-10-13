#!/usr/bin/env node
// Runs scripts/events.ts (see run.mjs). --help for usage.
import { run } from "./run.mjs";
run(import.meta.url);
