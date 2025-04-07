const fetch = require('node-fetch');

// --- Gemini API Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
const MAX_CONTENT_LENGTH = 15000; // Limit content sent to Gemini

// --- Helper Function: Basic HTML Text Extraction (Keep as is) ---
function extractTextFromHtml(html) {
    if (!html) return '';
    let text = html.replace(/<script[^>]*>([\S\s]*?)<\/script>/gmi, '');
    text = text.replace(/<style[^>]*>([\S\s]*?)<\/style>/gmi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

// --- Utility: Find or create branch using normalized comparisons ---
function getOrCreateBranch(currentLevel, categoryName, isLast = false) {
    const normalized = categoryName.trim().toLowerCase();
    // find a branch key that matches ignoring case
    for (const key of Object.keys(currentLevel)) {
        if (key.trim().toLowerCase() === normalized) {
            return { key, branch: currentLevel[key] };
        }
    }
    // Not found: create a new branch.
    // For the final level, we want an array to hold entries.
    const newBranch = isLast ? [] : {};
    currentLevel[categoryName] = newBranch;
    return { key: categoryName, branch: newBranch };
}

// --- Updated Tree Building Function ---
function buildUrlTree(history) {
    const tree = {}; // Root of the tree

    history.forEach(item => {
        if (!item.classification) return;
        const classification = item.classification;
        if (!classification) return;

        // Level 1: URL Type
        const urlType = classification.url_type || 'Unknown Type';
        const { branch: urlTypeBranch } = getOrCreateBranch(tree, urlType);
        
        // Level 2: Content Format — skip if "HTML"
        let currentLevel = urlTypeBranch;
        const contentFormat = classification.content_format || 'Unknown Format';
        if (contentFormat.trim().toLowerCase() !== 'html') {
            const result = getOrCreateBranch(currentLevel, contentFormat);
            currentLevel = result.branch;
        }
        // Else: if it is HTML, use the existing level without adding a branch.

        // Levels 3+: Content Type Hierarchy
        const hierarchy = (Array.isArray(classification.content_type_hierarchy) && classification.content_type_hierarchy.length > 0)
                              ? classification.content_type_hierarchy
                              : ['Unknown Category'];

        hierarchy.forEach((category, index) => {
            const isLastLevel = (index === hierarchy.length - 1);
            if (isLastLevel) {
                // For leaf level, get the branch (an array) or create if not exists.
                const { branch: leafBranch } = getOrCreateBranch(currentLevel, category, true);
                // Add the URL entry object if not already present.
                if (!leafBranch.some(entry => entry.id === item.id)) {
                    leafBranch.push({ id: item.id, url: item.url });
                }
            } else {
                const { branch: nextLevel } = getOrCreateBranch(currentLevel, category);
                currentLevel = nextLevel;
            }
        });
    });
    console.log("Built Tree:", tree);
    return tree;
}

// --- Netlify Function Handler ---
exports.handler = async (event, context) => {
    // 1. Check Method (Keep as is)
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed. Please use POST.' }) };
    }

    // 2. Get API Key (Keep as is)
    if (!GEMINI_API_KEY) {
         console.error("FATAL: GEMINI_API_KEY environment variable not set.");
         return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API Key missing.' }) };
    }

    // 3. Parse Request Body (Keep as is)
    let targetUrl;
    try {
        const body = JSON.parse(event.body);
        targetUrl = body.url;
        if (!targetUrl || !/^https?:\/\/.+/.test(targetUrl)) {
            throw new Error('Invalid or missing URL in request body.');
        }
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to parse request: ${error.message}` }) };
    }

    // --- Main Logic ---
    try {
        // 4. Fetch External Content (Keep as is, with User-Agent)
        console.log(`Fetching content from: ${targetUrl}`);
        const response = await fetch(targetUrl, {
             headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
             redirect: 'follow', timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch the URL (Status: ${response.status}). Site might be down or blocking requests.`);
        }

        const htmlContent = await response.text();
        console.log(`Fetched ${htmlContent.length} bytes.`);

        // 5. Extract & Truncate Text (Keep as is)
        const textContent = extractTextFromHtml(htmlContent);
        const truncatedContent = textContent.substring(0, MAX_CONTENT_LENGTH);
        if (textContent.length > MAX_CONTENT_LENGTH) {
            console.log(`Content truncated to ${MAX_CONTENT_LENGTH} characters.`);
        }
        if (!truncatedContent.trim()) {
             throw new Error("Could not extract meaningful text content from the URL.");
        }

        // 6. Prepare NEW Prompt for Gemini (Hierarchical JSON Output)
        const prompt = `
Analyze the following web page content and classify it according to the specified facets.
Provide the output ONLY as a valid JSON object adhering strictly to the structure below. Do not include any introductory text, explanations, or markdown formatting around the JSON.

JSON Output Structure:
{
  "classification": {
    "url_type": "...",           // e.g., "Website", "Blog", "News Site", "Forum", "E-commerce", "File", "Media Page", "Data Endpoint", "Other"
    "content_format": "...",     // e.g., "HTML", "PDF", "Image", "Video", "Audio", "JSON", "XML", "Text File", "Other"
    "content_type_hierarchy": [  // Array representing hierarchy, from general to specific.
      // e.g., ["Text", "News Article", "Technology"]
    ],
    "primary_language": "..."    // e.g., "English", "Spanish", "Japanese", "Undetermined"
  },
  "confidence": "High | Medium | Low",
  "keywords": ["...", "...", "..."]
}

Target URL (for context): ${targetUrl}
Webpage Text Content (extracted and possibly truncated):
---
${truncatedContent}
---

JSON Output:`;

        // 7. Call Gemini API
        console.log("Calling Gemini API for JSON classification...");
        const geminiResponse = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const geminiData = await geminiResponse.json();

        if (!geminiResponse.ok) {
             const errorDetails = geminiData.error?.message || `Status: ${geminiResponse.status}`;
             throw new Error(`Gemini API Error: ${errorDetails}`);
        }

        // 8. Extract and parse Classification JSON from the response.
        let classificationJson;
        let rawResultText = "No valid response received from AI.";
        if (geminiData.candidates && geminiData.candidates[0]?.content?.parts[0]?.text) {
            rawResultText = geminiData.candidates[0].content.parts[0].text;
            console.log("Raw AI Response Text:\n", rawResultText);
            try {
                const cleanJsonString = rawResultText
                    .replace(/^```json\s*/, '')
                    .replace(/```\s*$/, '')
                    .trim();
                classificationJson = JSON.parse(cleanJsonString);
                console.log("Parsed Classification JSON:", classificationJson);
            } catch (parseError) {
                console.error("Failed to parse JSON from AI response:", parseError);
                console.error("Problematic raw text:", rawResultText);
                throw new Error(`AI returned a response, but it was not valid JSON. Response: ${rawResultText.substring(0, 200)}...`);
            }
        } else if (geminiData.promptFeedback?.blockReason) {
             const blockMessage = `Content blocked by Gemini: ${geminiData.promptFeedback.blockReason}`;
             console.error(blockMessage);
              return {
                 statusCode: 400,
                 body: JSON.stringify({ error: blockMessage }),
             };
        } else {
             console.error("Gemini response OK, but no candidate text found.", geminiData);
             throw new Error("AI response was missing the expected content.");
        }

        // 9. Return Success Response
        return {
            statusCode: 200,
            body: JSON.stringify({ classification: classificationJson }),
        };

    } catch (error) {
        console.error("Error in Netlify function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Function failed: ${error.message}` }),
        };
    }
};