import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./db";
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
    const existing = db.query("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      return { success: false, error: "User already exists" };
    }

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    db.query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(userId, email, passwordHash);

    return { success: true };
  } catch (error) {
    return { success: false, error: "Registration failed" };
  }
}

// Login user
export async function loginUser(email: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const user = db.query("SELECT * FROM users WHERE email = ?").get(email) as User | null;

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
export function getUserById(userId: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(userId) as User | null;
}
