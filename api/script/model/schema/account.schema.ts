import mongoose from "mongoose";
import { Account } from "../../infrastructure/storage-types";

const accountSchema = new mongoose.Schema<Account>({
    id: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    createdTime: { type: Number, required: true, default: () => Date.now() },
}, {
    timestamps: true,
    versionKey: false
});

accountSchema.index({ email: 1 }, { unique: true });

export const AccountModel = mongoose.model<Account>("Account", accountSchema);