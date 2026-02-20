import argon2 from "argon2";

export const verifyPassword = async (plaintext: string): Promise<boolean> => {
  const storedHash = process.env.PASSWORD_HASH;
  if (storedHash === undefined || storedHash === "") {
    throw new Error("PASSWORD_HASH environment variable is not set");
  }

  return argon2.verify(storedHash, plaintext);
};

export const hashPassword = async (plaintext: string): Promise<string> =>
  argon2.hash(plaintext, { type: argon2.argon2id });
