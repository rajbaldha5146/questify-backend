const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const Document = require("../models/Document");
const axios = require("axios");
const dotenv = require("dotenv");
const router = express.Router();

dotenv.config();

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

const upload = multer({ storage });

// File upload endpoint
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    // Validate file type
    if (req.file.mimetype !== "application/pdf" && req.file.mimetype !== "text/plain") {
      return res.status(400).json({ message: "Only PDF and text files are allowed" });
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
      userId: req.user.id, // Ensure userId is set correctly
    });
    await document.save();

    res.status(200).json({ message: "File uploaded successfully", document });
  } catch (error) {
    console.error("Error during file upload:", error);
    res.status(500).json({ message: "File upload failed" });
  }
});

// Fetch all documents for the authenticated user
router.get("/documents", async (req, res) => {
  try {
    const documents = await Document.find({ userId: req.user.id }).sort({ uploadDate: -1 });
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
    res.status(200).json(document);
  } catch (error) {
    console.error("Error fetching document:", error);
    res.status(500).json({ message: "Failed to fetch document" });
  }
});

// Summarization endpoint
router.post("/summarize", async (req, res) => {
  try {
    const { documentId } = req.body;

    // Find the document by ID
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
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

    // Save the summary to the document
    document.summary = combinedSummary;
    await document.save();

    res.status(200).json({ summary: combinedSummary });
  } catch (error) {
    console.error("Error during summarization:", error.response?.data || error.message);
    res.status(500).json({ message: "Summarization failed" });
  }
});

// Q&A endpoint
router.post("/ask", async (req, res) => {
  try {
    const { documentId, question } = req.body;
    // console.log("Received Document ID:", documentId); // Log the documentId

    // Find the document by ID
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Send the document text and question to the Hugging Face API for Q&A
    const apiUrl = "https://api-inference.huggingface.co/models/deepset/roberta-base-squad2"; // Example Q&A model
    const response = await axios.post(
      apiUrl,
      {
        inputs: {
          question: question,
          context: document.text, // Use the document text as context
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGING_FACE_API_TOKEN}`,
        },
      }
    );

    // Extract the answer from the response
    const answer = response.data.answer;

    res.status(200).json({ answer });
  } catch (error) {
    console.error("Error during Q&A:", error.response?.data || error.message);
    res.status(500).json({ message: "Q&A failed" });
  }
});

// Q&A history endpoint
router.get("/qa-history/:documentId", async (req, res) => {
  try {
    const document = await Document.findById(req.params.documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.status(200).json(document.qaHistory);
  } catch (error) {
    console.error("Error fetching Q&A history:", error);
    res.status(500).json({ message: "Failed to fetch Q&A history" });
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

// Helper function to summarize text using Hugging Face API
const summarizeText = async (text) => {
  const apiUrl = "https://api-inference.huggingface.co/models/facebook/bart-large-cnn"; // Example summarization model
  const response = await axios.post(
    apiUrl,
    {
      inputs: text,
      parameters: {
        max_length: 130, // Maximum length of the summary
        min_length: 30,  // Minimum length of the summary
        do_sample: false, // Disable sampling for deterministic output
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUGGING_FACE_API_TOKEN}`,
      },
    }
  );
  return response.data[0].summary_text;
};

module.exports = router;