import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "./db";
import { randomUUID } from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

export interface JWTPayload {
  userId: string;
  email: string;
}

// Register a new user
export async function registerUser(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if user exists
    const existingResult = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingResult.rows.length > 0) {
      return { success: false, error: "User already exists" };
    }

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
      [userId, email, passwordHash]
    );

    return { success: true };
  } catch (error) {
    console.error("[Auth] Registration error:", error);
    return { success: false, error: "Registration failed" };
  }
}

// Login user
export async function loginUser(email: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0] as User | undefined;

    if (!user) {
      return { success: false, error: "Invalid credentials" };
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return { success: false, error: "Invalid credentials" };
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email } as JWTPayload,
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return { success: true, token };
  } catch (error) {
    console.error("[Auth] Login error:", error);
    return { success: false, error: "Login failed" };
  }
}

// Verify JWT token
export function verifyToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    return decoded;
  } catch (error) {
    return null;
  }
}

// Get user by ID
export async function getUserById(userId: string): Promise<User | null> {
  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    return result.rows[0] as User | null;
  } catch (error) {
    console.error("[Auth] Get user error:", error);
    return null;
  }
}
