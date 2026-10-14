# Local diagnostic scopes

`prewarm_catalog_page` and `read_diagnostic_example` are bounded read-only diagnostics. They do not grant catalog FULL, native eligibility, or permission to repeat an unknown operation. Their existing traversal, snapshot, getter-gap and verified-PNG guards still apply.

Both tools fail closed until the host has an explicit scope. Copy `diagnostic-scopes.example.json` to `diagnostic-scopes.local.json` beside `package.json`, and replace the invented example identifiers with the file/Page/roots that you are authorized to inspect. The repository already ignores `*.local.json`; never commit this private configuration. Alternatively set `FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE` to an absolute local JSON path. Tool callers cannot choose that path or extend the allowlist through their arguments.

The configuration is strict version 1. A missing operation is disabled. The example reader accepts only the configured file, Page and node IDs, and checks the configured parent during traversal and offline proof verification. The prewarm route accepts only its configured file and Page. Invalid or missing configuration produces a redacted error before operation code is generated.

The pure offline `verifyDiagnosticProof` function now requires an explicit `scope` argument. `collectDiagnosticRoot` reads the host configuration once and supplies that scope to the proof. A diagnostic proof remains diagnostic evidence; it is not independent source admission. The legacy traversal/projection labels are retained for protocol compatibility.

All committed fixtures use invented identifiers. Installation and runtime switching are separate actions; changing repository code does not update a running plugin or reset its journals.
