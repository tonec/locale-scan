export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};
