// Used by bench/profile.js: starts a server, and exits cleanly when the parent
// sends "stop", so Node writes the --cpu-prof profile on every platform.
process.on("message", (msg) => {
  if (msg === "stop") process.exit(0);
});

await import(`../${process.argv[2]}.js`);
