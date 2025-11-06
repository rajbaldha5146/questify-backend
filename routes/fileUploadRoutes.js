const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const Document = require("../models/Document");
const Summary = require("../models/Summary");
const QAHistory = require("../models/QAHistory");
const Groq = require("groq-sdk");
const dotenv = require("dotenv");
const router = express.Router();

dotenv.config();

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Multer configuration for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir); // Save files in the 'uploads' folder
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname); // Unique filename
  },
});

// File size limit: 10MB
const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.mimetype === "text/plain") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and text files are allowed"), false);
    }
  }
});

// File cleanup function
const cleanupFile = (filePath) => {
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting file:", err);
    });
  }, 24 * 60 * 60 * 1000); // Delete after 24 hours
};

const { aiOperationsLimiter } = require("../middleware/rateLimiter");

// File upload endpoint
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    // Validate file type
    if (
      req.file.mimetype !== "application/pdf" &&
      req.file.mimetype !== "text/plain"
    ) {
      return res
        .status(400)
        .json({ message: "Only PDF and text files are allowed" });
    }

    const filePath = req.file.path;
    let extractedText = "";

    // Extract text from PDF
    if (req.file.mimetype === "application/pdf") {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      extractedText = data.text;
    } else if (req.file.mimetype === "text/plain") {
      extractedText = fs.readFileSync(filePath, "utf-8");
    }

    // Save document metadata and extracted text to MongoDB
    const document = new Document({
      filename: req.file.originalname,
      filepath: filePath,
      text: extractedText,
      userId: req.user.id,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });
    await document.save();

    // Schedule file cleanup after 24 hours
    cleanupFile(filePath);

    res.status(200).json({ message: "File uploaded successfully", document });
  } catch (error) {
    console.error("Error during file upload:", error);
    res.status(500).json({ message: "File upload failed" });
  }
});

// Fetch all documents for the authenticated user
router.get("/documents", async (req, res) => {
  try {
    const documents = await Document.find({ userId: req.user.id }).sort({
      uploadDate: -1,
    });
    res.status(200).json(documents);
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({ message: "Failed to fetch documents" });
  }
});

// Fetch a single document by ID
router.get("/documents/:id", async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    
    // Check if user owns the document
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to access this document" });
    }
    
    res.status(200).json(document);
  } catch (error) {
    console.error("Error fetching document:", error);
    res.status(500).json({ message: "Failed to fetch document" });
  }
});

// Get summary for a document
router.get("/summary/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    
    // Check if document exists and user owns it
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to access this document" });
    }

    // Find existing summary
    const summary = await Summary.findOne({ documentId, userId: req.user.id });
    if (!summary) {
      return res.status(404).json({ message: "Summary not found" });
    }

    res.status(200).json({ summary: summary.content, createdAt: summary.createdAt });
  } catch (error) {
    console.error("Error fetching summary:", error);
    res.status(500).json({ message: "Failed to fetch summary" });
  }
});

// Summarization endpoint
router.post("/summarize", aiOperationsLimiter, async (req, res) => {
  try {
    const { documentId } = req.body;

    // Find the document by ID
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    
    // Check if user owns the document
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to access this document" });
    }

    // Check if summary already exists
    let existingSummary = await Summary.findOne({ documentId, userId: req.user.id });
    if (existingSummary) {
      return res.status(200).json({ summary: existingSummary.content });
    }

    // Split the document text into chunks (e.g., 1000 words per chunk)
    const textChunks = splitTextIntoChunks(document.text, 1000);

    // Summarize each chunk
    const summaries = [];
    for (const chunk of textChunks) {
      const summary = await summarizeText(chunk);
      summaries.push(summary);
    }

    // Combine the summaries into one
    const combinedSummary = summaries.join(" ");

    // Save the summary to the Summary collection
    const newSummary = new Summary({
      documentId,
      userId: req.user.id,
      content: combinedSummary,
    });
    await newSummary.save();

    res.status(200).json({ summary: combinedSummary });
  } catch (error) {
    console.error(
      "Error during summarization:",
      error.response?.data || error.message
    );
    res.status(500).json({ message: "Summarization failed" });
  }
});

// Q&A endpoint
router.post("/ask", aiOperationsLimiter, async (req, res) => {
  try {
    const { documentId, question } = req.body;

    // Find the document by ID
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    
    // Check if user owns the document
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to access this document" });
    }

    // Use Groq API for Q&A
    const answer = await answerQuestion(document.text, question);

    // Save Q&A to QAHistory collection
    const qaEntry = new QAHistory({
      documentId,
      userId: req.user.id,
      question,
      answer,
    });
    await qaEntry.save();

    res.status(200).json({ answer });
  } catch (error) {
    console.error("Error during Q&A:", error.message);
    res.status(500).json({ message: "Q&A failed" });
  }
});

// Q&A history endpoint
router.get("/qa-history/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    
    // Check if document exists and user owns it
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to access this document" });
    }

    // Fetch Q&A history for this document and user
    const qaHistory = await QAHistory.find({ 
      documentId, 
      userId: req.user.id 
    }).sort({ createdAt: -1 }); // Sort by newest first

    res.status(200).json(qaHistory);
  } catch (error) {
    console.error("Error fetching Q&A history:", error);
    res.status(500).json({ message: "Failed to fetch Q&A history" });
  }
});

// Delete document endpoint
router.delete("/documents/:id", async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Check if user owns the document
    if (document.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized to delete this document" });
    }

    // Delete related summaries and Q&A history
    await Summary.deleteMany({ documentId: req.params.id, userId: req.user.id });
    await QAHistory.deleteMany({ documentId: req.params.id, userId: req.user.id });

    // Delete the physical file
    if (fs.existsSync(document.filepath)) {
      fs.unlinkSync(document.filepath);
    }

    // Delete from database
    await Document.findByIdAndDelete(req.params.id);

    res.status(200).json({ message: "Document and related data deleted successfully" });
  } catch (error) {
    console.error("Error deleting document:", error);
    res.status(500).json({ message: "Failed to delete document" });
  }
});

// Helper function to split text into chunks
const splitTextIntoChunks = (text, chunkSize) => {
  const words = text.split(" ");
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
};

// Helper function to summarize text using Groq API
const summarizeText = async (text) => {
  try {
    // Truncate text if it's too long (Groq has token limits)
    const maxLength = 8000; // Approximate character limit
    const truncatedText =
      text.length > maxLength ? text.substring(0, maxLength) + "..." : text;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that creates concise, informative summaries. Provide a summary that captures the key points and main ideas of the given text.",
        },
        {
          role: "user",
          content: `Please summarize the following text:\n\n${truncatedText}`,
        },
      ],
      model: "groq/compound-mini", // Using Groq Compound Mini model
      temperature: 0.3,
      max_tokens: 500,
    });

    const summary =
      chatCompletion.choices[0]?.message?.content || "Summary not available";
    return summary;
  } catch (error) {
    console.error("Error in summarizeText:", error.message);
    console.error("Full error:", error);
    throw new Error(`Summarization failed: ${error.message}`);
  }
};

// Helper function to answer questions using Groq API
const answerQuestion = async (context, question) => {
  try {
    // Truncate context if it's too long but keep more content for better answers
    const maxLength = 12000;
    const truncatedContext =
      context.length > maxLength
        ? context.substring(0, maxLength) + "..."
        : context;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that answers questions based on the provided document content. 
          
          Instructions:
          - Carefully read through the entire context provided
          - Answer questions based ONLY on the information in the document
          - If you find relevant information, provide a clear and detailed answer
          - If the specific information is not in the document, say "I cannot find this specific information in the provided document."
          - Be thorough in your search through the context before concluding information is missing
          - Format your response clearly and professionally`,
        },
        {
          role: "user",
          content: `Document Content:\n${truncatedContext}\n\nQuestion: ${question}\n\nPlease provide a detailed answer based on the document content above.`,
        },
      ],
      model: "groq/compound-mini", // Using Groq Compound Mini model
      temperature: 0.2,
      max_tokens: 500,
    });

    const answer =
      chatCompletion.choices[0]?.message?.content || "Answer not available";
    return answer;
  } catch (error) {
    console.error("Error in answerQuestion:", error.message);
    console.error("Full error:", error);
    throw new Error(`Q&A failed: ${error.message}`);
  }
};



module.exports = router;
