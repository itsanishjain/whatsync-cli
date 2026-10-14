/** An error whose message is safe and useful to show the person as is. */
export class CliError extends Error {
    constructor(message: string, readonly exitCode = 1) {
        super(message);
        this.name = "CliError";
    }
}
