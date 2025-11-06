const mongoose = require("mongoose");

const qaHistorySchema = new mongoose.Schema({
  documentId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Document", 
    required: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  question: { 
    type: String, 
    required: true 
  },
  answer: { 
    type: String, 
    required: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Create indexes for faster queries
qaHistorySchema.index({ documentId: 1, userId: 1 });
qaHistorySchema.index({ createdAt: -1 }); // For sorting by date

module.exports = mongoose.model("QAHistory", qaHistorySchema);