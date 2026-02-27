// ============= config/consoleLogger.js =============
// Drop-in verbose console logger for StackSwap backend
// Every stage of the offramp pipeline logs with color, emoji, timestamps.
// Set NO_COLOR=1 to strip ANSI for log file piping.

const useColor = !process.env.NO_COLOR;

const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  bold:   useColor ? "\x1b[1m"  : "",
  dim:    useColor ? "\x1b[2m"  : "",
  cyan:   useColor ? "\x1b[36m" : "",
  green:  useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  red:    useColor ? "\x1b[31m" : "",
  blue:   useColor ? "\x1b[34m" : "",
  orange: useColor ? "\x1b[38;5;208m" : "",
  purple: useColor ? "\x1b[35m" : "",
  gray:   useColor ? "\x1b[90m" : "",
  white:  useColor ? "\x1b[97m" : "",
};

function ts() {
  return `${c.gray}[${new Date().toISOString()}]${c.reset}`;
}

function divider(label = "") {
  const line = "─".repeat(60);
  if (label) {
    console.log(`\n${c.cyan}${c.bold}${line}${c.reset}`);
    console.log(`${c.cyan}${c.bold}  ${label}${c.reset}`);
    console.log(`${c.cyan}${c.bold}${line}${c.reset}\n`);
  } else {
    console.log(`${c.gray}${line}${c.reset}`);
  }
}

function box(lines) {
  console.log(`${c.gray}  ┌${"─".repeat(58)}┐${c.reset}`);
  lines.forEach((line) => {
    console.log(`${c.gray}  │${c.reset} ${line}`);
  });
  console.log(`${c.gray}  └${"─".repeat(58)}┘${c.reset}`);
}

// Tag factories — each module gets its own colored tag
function makeLogger(tag, tagColor) {
  return {
    info:    (msg) => console.log(`${ts()} ${tagColor}${c.bold}[${tag}]${c.reset} ${msg}`),
    success: (msg) => console.log(`${ts()} ${c.green}${c.bold}[${tag}]${c.reset} ${c.green}${msg}${c.reset}`),
    warn:    (msg) => console.warn(`${ts()} ${c.yellow}${c.bold}[${tag}]${c.reset} ${c.yellow}${msg}${c.reset}`),
    error:   (msg) => console.error(`${ts()} ${c.red}${c.bold}[${tag}]${c.reset} ${c.red}${msg}${c.reset}`),
    step:    (n, msg) => console.log(`${ts()} ${tagColor}${c.bold}[${tag}]${c.reset} ${c.bold}STEP ${n}${c.reset} — ${msg}`),
    data:    (label, obj) => console.log(`${ts()} ${tagColor}${c.bold}[${tag}]${c.reset} ${c.dim}${label}:${c.reset}\n${JSON.stringify(obj, null, 2)}`),
    divider,
    box,
  };
}

module.exports = {
  // One logger per module
  offramp:  makeLogger("Offramp",  c.orange),
  poll:     makeLogger("Poll",     c.purple),
  lenco:    makeLogger("Lenco",    c.blue),
  indexer:  makeLogger("Indexer",  c.cyan),
  route:    makeLogger("Route",    c.gray),
  c,
  ts,
  divider,
  box,
};