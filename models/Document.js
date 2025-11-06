const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  filepath: { type: String, required: true },
  text: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  uploadDate: { type: Date, default: Date.now },
  fileSize: { type: Number }, // Optional: store file size
  mimeType: { type: String }, // Optional: store mime type
});

// Create index for faster queries
documentSchema.index({ userId: 1, uploadDate: -1 });

module.exports = mongoose.model("Document", documentSchema);