# Creditcoin Ops Scripts

A collection of commands for certain common (but complicated) ops tasks
for creditcoin.

## Usage

- Check out this repo

- [Install deno](https://docs.deno.com/runtime/manual#install-deno)

- Run

    ```bash
    deno run --allow-run=kubectl main.ts
    ```

    This will print out the help info for the CLI, showing all of the commands available.

    The `--allow-run=kubectl` flag, which is passed to `deno`, allows `main.ts` to execute the binary
    `kubectl`, but since deno is sandboxed, the script cannot access anything else (in other words,
    you can be sure it won't read or write other files, or access env vars, or make network requests).
    If you don't care about sandboxing, you can just grant all permissions with `-A`, i.e.
    `deno run -A main.ts`.

    From there, you can just add the arguments to call a command. For instance, to call the
    `resize-statefulset-pvcs` command:

    ```bash
    deno run --allow-run=kubectl main.ts resize-statefulset-pvcs --new-size 75Gi mains-miner-creditcoin-miner
    ```
