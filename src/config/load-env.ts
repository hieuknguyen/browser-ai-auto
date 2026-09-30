// Environment files stay on the engine host and are never sent to the viewer.
try { process.loadEnvFile(); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
