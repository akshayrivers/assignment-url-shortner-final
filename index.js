import express from 'express';
import PocketBase from 'pocketbase';
import { nanoid } from 'nanoid';
import { config } from 'dotenv'
config()
const app = express();
app.use(express.json());

// Initialize PocketBase client (make sure your PocketBase server is running)
// Also, authenticate as admin so we can update records if needed.
const pb = new PocketBase('http://127.0.0.1:8090');
const adminAuth = await pb.admins.authWithPassword('akshayforrivers@gmail.com', process.env.password);

// Default time limit: 1 hour in milliseconds
const DEFAULT_TIME_LIMIT = 3600000;

/**
 * NOTE: FOR EXPIRY I COULD THINK OF A SIMPLE APPROACH WHERE USER SPECIFIES THE TIME LIEK HOW MANY MINUTES OR HOURS
 * WHICH WE CAN THEN STORE ALONG WITH OTHER ORIGINAL LINK, SHORT CODE AND CREATED. SO WHENEVER WE HAVE TO SEE 
 * IF IT IS ACTIVE OR NOT WE WILL JUST COMPARE CREATED+EXPIRY WITH DATE.NOW WHICH WILL EASE OUR PROCESS 
 * AND BY DEFAULT WE HAVE ALREADY SET IT TO 1 HOUR 
 * ALSO NOTE THAT WE HAVE SET THE CREATED FIELD TO CHANGE AFTER CREATION AND UPDATION BOTH 
 */
/**
 * POST /shorten
 * Expects a JSON body with:
 *   - link: The original URL to shorten.
 * 
 * Logic:
 *   - If a record for the URL exists:
 *       - If its "created" time plus the expiry duration (or default time) is older than Date.now(),
 *         update it with a new short code and refresh expiry.
 *       - Otherwise, update the existing record's expiry and created fields and return the same short code.
 *   - If no record exists, create a new one.
 */
app.post("/shorten", async (req, res) => {
    // to create a dynamic time expiry window
    try {
        const { link, expiry } = req.body;
        if (!link) {
            return res.status(400).json({ error: 'Link is required.' });
        }

        const now = new Date();
        // Calculate effective expiry duration (in milliseconds)
        const effectiveExpiry = expiry ? parseInt(expiry) : DEFAULT_TIME_LIMIT;

        // Check if a record already exists for the provided link.
        const filter = `originalUrl="${link}"`;
        const existingRecords = await pb.collection('urls').getFullList({ filter });

        if (existingRecords.length > 0) {
            const record = existingRecords[0];
            const createdTime = new Date(record.created);
            // Calculate when this record expires: created time + effective expiry duration
            const expiryTime = createdTime.getTime() + effectiveExpiry;
            if (now.getTime() > expiryTime) {
                // Record is expired, update it with a new short code and refresh expiry
                const newShortCode = nanoid(6);
                const updatedRecord = await pb.collection('urls').update(record.id, {
                    shortCode: newShortCode,
                    expiry: effectiveExpiry.toString()  // store as text
                });
                return res.json({
                    shortCode: updatedRecord.shortCode,
                    message: 'Existing URL expired; updated with new short code.'
                });
            } else {
                // Record is still active; update the expiry and created fields and return the same short code.
                const updatedRecord = await pb.collection('urls').update(record.id, {
                    created: now.toISOString(),
                    expiry: effectiveExpiry.toString()
                });
                return res.json({
                    shortCode: updatedRecord.shortCode,
                    message: 'Existing URL is still active; expiry and created updated, returning same short code.'
                });
            }
        } else {
            // No record exists, create a new one.
            const shortCode = nanoid(6);
            const data = { originalUrl: link, shortCode, expiry: effectiveExpiry.toString() };
            const newRecord = await pb.collection('urls').create(data);
            return res.json({
                shortCode: newRecord.shortCode,
                message: 'New URL record created.'
            });
        }
    } catch (error) {
        console.error('Error in /shorten:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * GET /stats/active
 * Returns the active URLs (those created within the last hour or within their expiry duration),
 * grouped by creation date, along with the list of active records.
 */
app.get("/stats/active", async (req, res) => {
    try {
        const now = new Date();
        const records = await pb.collection('urls').getFullList();

        // Filter to keep only records that are still active.
        const activeRecords = records.filter(record => {
            const createdTime = new Date(record.created);
            // Use the stored expiry value from the record (or default if not set)
            const expiryDuration = parseInt(record.expiry) || DEFAULT_TIME_LIMIT;
            return createdTime.getTime() + expiryDuration > now.getTime();
        });

        // Group active records by their creation date (formatted as YYYY-MM-DD).
        const groupByDate = {};
        activeRecords.forEach(record => {
            const date = new Date(record.created).toISOString().split('T')[0];
            groupByDate[date] = (groupByDate[date] || 0) + 1;
        });

        const groups = Object.keys(groupByDate).map(date => ({
            date,
            count: groupByDate[date]
        }));

        return res.json({ total: activeRecords.length, groups, activeRecords });
    } catch (error) {
        console.error('Error in /stats/active:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * GET /urls/recent
 * Returns the 5 most recently created short URLs.
 */
app.get("/urls/recent", async (req, res) => {
    try {
        const records = await pb.collection('urls').getFullList();
        // Sort records descending by creation date.
        records.sort((a, b) => new Date(b.created) - new Date(a.created));
        const recentRecords = records.slice(0, 5).map(record => ({
            shortCode: record.shortCode,
            originalUrl: record.originalUrl
        }));

        return res.json(recentRecords);
    } catch (error) {
        console.error('Error in /urls/recent:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /urls/batch
 * Expects a JSON body with:
 *   - links: An array of long URLs.
 * For each URL:
 *   - If a record exists and its creation time plus expiry duration is in the past, update it with a new short code.
 *   - Otherwise, create a new record.
 * This endpoint now iterates over the links array and performs each request normally.
 */
app.post("/urls/batch", async (req, res) => {
    try {
        const { links, expiry } = req.body;
        if (!links || !Array.isArray(links)) {
            return res.status(400).json({ error: 'Links must be provided as an array.' });
        }

        // Build a filter string to get existing records for all provided links.
        const filter = links.map(link => `originalUrl="${link}"`).join(' || ');
        let existingRecords = [];
        if (links.length > 0) {
            existingRecords = await pb.collection('urls').getFullList({ filter });
        }

        // Create a map of originalUrl to the most recent record.
        const existingMap = {};
        existingRecords.forEach(record => {
            const url = record.originalUrl;
            if (!existingMap[url] || new Date(record.created) > new Date(existingMap[url].created)) {
                existingMap[url] = record;
            }
        });

        const results = [];
        const now = new Date();
        // Calculate effective expiry duration for this request.
        const effectiveExpiry = expiry ? parseInt(expiry) : DEFAULT_TIME_LIMIT;
        for (const link of links) {
            if (existingMap[link]) {
                const record = existingMap[link];
                const createdTime = new Date(record.created);
                const expiryDuration = parseInt(record.expiry) || DEFAULT_TIME_LIMIT;
                const expiryTime = createdTime.getTime() + expiryDuration;
                if (now.getTime() > expiryTime) {
                    // Record is expired, update it with a new short code and refresh expiry
                    const newShortCode = nanoid(6);
                    const updatedRecord = await pb.collection('urls').update(record.id, {
                        shortCode: newShortCode,
                        expiry: effectiveExpiry.toString()
                    });
                    results.push({ link, shortCode: updatedRecord.shortCode, action: 'updated' });
                } else {
                    // Record is still active; update the expiry and created fields and return the same short code.
                    const updatedRecord = await pb.collection('urls').update(record.id, {
                        created: now.toISOString(),
                        expiry: effectiveExpiry.toString()
                    });
                    results.push({ link, shortCode: updatedRecord.shortCode, action: 'updated' });
                }
            } else {
                // No record exists, create a new one.
                const shortCode = nanoid(6);
                const data = { originalUrl: link, shortCode, expiry: effectiveExpiry.toString() };
                const newRecord = await pb.collection('urls').create(data);
                results.push({ link, shortCode: newRecord.shortCode, action: 'created' });
            }
        }

        return res.json(results);
    } catch (error) {
        console.error('Error in /urls/batch:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});


// Start the Express server.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
