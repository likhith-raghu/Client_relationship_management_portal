const dotenv = require('dotenv');
const result = dotenv.config();

if (result.error) {
  console.error("Error loading .env file", result.error);
} else {
  console.log("Loaded .env file", result.parsed);
}

console.log('MONGODB_URI from .env:', process.env.MONGODB_URI);
console.log('JWT_SECRET from .env:', process.env.JWT_SECRET);

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const Grid = require('gridfs-stream');
const methodOverride = require('method-override');





const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

const Client = require('./models/client.js');
const Syndicate = require('./models/syndicate.js');
const Admin = require('./models/admin.js');

const JWT_SECRET = process.env.JWT_SECRET;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((err) => {
  console.error('Error connecting to MongoDB', err);
  process.exit(1);
});

// Init GridFS
let gfs;

mongoose.connection.once('open', () => {
  gfs = Grid(mongoose.connection.db, mongoose.mongo);
  gfs.collection('uploads');
  console.log('GridFS initialized');
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Temporary workaround to ensure MONGODB_URI is defined
process.env.MONGODB_URI = 'mongodb+srv://shakthi:shakthi@shakthi.xuq11g4.mongodb.net/?retryWrites=true&w=majority';

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
      cb(null, path.join(__dirname, 'uploads', 'blob'));
  },
  filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });


// WebSocket connection
io.on('connection', (socket) => {
  console.log('a user connected');
  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

const router = express.Router();

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const tokenHeader = req.headers['authorization'];
  console.log('Authorization header:', tokenHeader);
  if (!tokenHeader) {
    console.error('No token provided');
    return res.sendStatus(401);
  }

  const token = tokenHeader.split(' ')[1]; // Extract token from "Bearer <token>"
  console.log('Extracted token:', token);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('Failed to verify token:', err);
      return res.sendStatus(403);
    }
    console.log('Token verified, user:', user);
    req.user = user;
    next();
  });
}

function generateEmailAuthToken(email) {
  const payload = { email };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' }); // Token expires in 1 hour
  return token;
}

router.post('/generate-email-auth-token', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const token = generateEmailAuthToken(email);
    res.status(200).json({ token });
  } catch (error) {
    console.error('Error generating email auth token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//visitor register
app.post('/register', upload.single('faceImage'), async (req, res) => {
  const { name, phone, email, companyName, personToMeet, personReferred, syndicate_name } = req.body;
  const faceImage = req.file ? req.file.filename : '';
  if (!name || !phone || !email || !companyName || !personToMeet || !personReferred || !syndicate_name) {
      return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
      const newClient = new Client({
          name,
          phone,
          email,
          companyName,
          personToMeet,
          personReferred,
          syndicate_name: syndicate_name.trim(),
          faceImage
      });

      await newClient.save();
      res.status(201).json({ message: 'Registration successful!' });
  } catch (error) {
      console.error('Error saving client:', error);
      res.status(500).json({ error: 'Error during registration. Please try again later.' });
  }
});

// Login route
app.post('/login', async (req, res) => {
  console.log('Login Request Body:', req.body);  // Log request body
  const { email, password } = req.body;
  try {
    const client = await Client.findOne({ email });
    if (!client) {
      console.log('User not found for email:', email);
      return res.status(404).json({ message: 'User not found' });
    }
    const isPasswordMatch = await bcrypt.compare(password, client.password);
    if (!isPasswordMatch) {
      console.log('Invalid password for email:', email);
      return res.status(401).json({ message: 'Invalid password' });
    }
    const token = jwt.sign({ id: client._id, email: client.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ email: client.email, token: token, message: 'Login successful' });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.post('/api/submit-form', authenticateToken, async (req, res) => {
  const formData = req.body;
  console.log('Authenticated user:', req.user);
  console.log('Form data received:', formData);

  try {
      const existingClient = await Client.findOne({ email: req.user.email });
      if (!existingClient) {
          console.error('Client not found for email:', req.user.email);
          return res.status(404).json({ error: 'Client not found' });
      }

      // Create an update object with only the fields that are not empty
      const updateData = {};
      for (const key in formData) {
          if (formData.hasOwnProperty(key) && formData[key] !== '' && formData[key] !== null) {
              updateData[key] = formData[key];
          }
      }

      // Specifically handle nested objects to ensure partial updates
      if (formData.market_access) {
          updateData.market_access = { ...existingClient.market_access?.toObject() || {}, ...formData.market_access };
      }
      if (formData.expert_talent) {
          updateData.expert_talent = { ...existingClient.expert_talent?.toObject() || {}, ...formData.expert_talent };
      }
      if (formData.product_creation) {
          updateData.product_creation = { ...existingClient.product_creation?.toObject() || {}, ...formData.product_creation };
      }
      if (formData.manufacturing) {
          updateData.manufacturing = { ...existingClient.manufacturing?.toObject() || {}, ...formData.manufacturing };
      }
      if (formData.funding) {
          updateData.funding = { ...existingClient.funding?.toObject() || {}, ...formData.funding };
      }

      const updatedClient = await Client.findOneAndUpdate(
          { email: req.user.email },
          { $set: updateData },
          { new: true }
      );

      console.log('Client updated successfully:', updatedClient);
      res.status(201).json(updatedClient);
  } catch (error) {
      console.error('Error submitting client data:', error);
      res.status(500).json({ error: 'Failed to submit client data' });
  }
});
// Syndicate login route
app.post('/syndicate-login', async (req, res) => {
  let { syndicate_name, password } = req.body;

  // Validate inputs
  if (!syndicate_name || !password) {
    return res.status(400).json({ message: 'Syndicate name and password are required' });
  }

  syndicate_name = syndicate_name.trim();

  try {
    const syndicateUser = await Syndicate.findOne({ syndicate_name });
    if (!syndicateUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isPasswordMatch = await bcrypt.compare(password, syndicateUser.password);
    if (!isPasswordMatch) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    const token = jwt.sign({ id: syndicateUser._id, syndicate_name: syndicateUser.syndicate_name }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ message: 'Syndicate login successful', token });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to get clients for a specific syndicate
app.get('/syndicate-data', async (req, res) => {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];

  try {
    if (!token) {
      return res.status(401).json({ message: 'Token not provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const clients = await Client.find({ syndicate_name: decoded.syndicate_name.trim() });
    res.json(clients);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



app.post('/update-client-data/:clientId', authenticateToken, async (req, res) => {
  const clientId = req.params.clientId;
  const editedData = req.body;

  console.log(`Received update for client ID: ${clientId}`, editedData); // Log client ID and data

  try {
      const existingClient = await Client.findById(clientId);
      if (!existingClient) {
          console.error(`Client not found: ${clientId}`); // Log if client not found
          return res.status(404).json({ error: 'Client not found' });
      }

      // Update the client data with the editedData
      Object.keys(editedData).forEach(key => {
          existingClient[key] = editedData[key];
      });

      // Save the updated client data
      await existingClient.save();
      res.status(200).json(existingClient);
  } catch (error) {
      console.error('Error saving edited data:', error);
      res.status(500).json({ error: 'Failed to save edited data' });
  }
});



app.post('/send-approval-request/:clientId', authenticateToken, async (req, res) => {
  const clientId = req.params.clientId;
  const { adminComments } = req.body;

  console.log('Received approval request for client:', clientId);
  console.log('Admin comments:', adminComments);

  try {
    const updatedClient = await Client.findByIdAndUpdate(clientId, {
      approved: false,
      adminComment: adminComments || ''
    }, { new: true });

    if (!updatedClient) {
      console.error('Client not found');
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('Client updated successfully:', updatedClient);
    res.status(200).json({ message: 'Approval request sent', client: updatedClient });
  } catch (error) {
    console.error('Error sending approval request:', error);
    res.status(500).json({ error: 'Failed to send approval request' });
  }
});



// Admin login route
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Attempting login with username: ${username} and password: ${password}`);

  try {
      const admin = await Admin.findOne({ username });
      if (!admin) {
          console.log('No admin found with that username');
          return res.status(401).json({ error: 'Invalid username or password' });
      }

      const passwordMatch = await bcrypt.compare(password, admin.password);
      if (!passwordMatch) {
          console.log('Password does not match');
          return res.status(401).json({ error: 'Invalid username or password' });
      }

      const token = jwt.sign({ id: admin._id }, JWT_SECRET, { expiresIn: '1h' });
      console.log('Login successful, admin ID:', admin._id);
      res.status(200).json({ token, adminId: admin._id }); // Ensure adminId is sent back in the response
  } catch (error) {
      console.error('Error during login:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});

  router.post('/api/clientFieldData', authenticateToken, async (req, res) => {
      try {
          const data = req.body;
  
          // Find the client in MongoDB by email
          const client = await Client.findOne({ email: req.user.email });
          if (!client) {
              return res.status(404).json({ error: 'Client not found' });
          }
  
          // Ensure clientFieldData exists and initialize if it doesn't
          if (!client.clientFieldData) {
              client.clientFieldData = {};
          }
  
          // Update each field in clientFieldData separately
          for (let field in data) {
              // Ensure each field in data is not undefined
              if (data.hasOwnProperty(field) && data[field] !== undefined && data[field] !== null) {
                  client.clientFieldData[field] = data[field];
              }
          }
  
          // Save the client document
          await client.save();
  
          res.status(200).json({ message: 'Data submitted successfully' });
      } catch (error) {
          console.error('Error submitting client field data:', error);
          res.status(500).json({ error: 'Internal server error' });
      }
  });
// GET route to fetch client field data
router.get('/api/clientdata', authenticateToken, async (req, res) => {
  console.log('Fetching client data for email:', req.user.email); // Log email
  
  try {
      const client = await Client.findOne({ email: req.user.email }); // Assuming email is stored in req.user
      if (!client) {
          console.log('Client not found for email:', req.user.email); // Log if client not found
          return res.status(404).json({ error: 'Client not found' });
      }
      // Extract and send the client field data as needed
      const clientFieldData = client.clientFieldData;
      console.log('Client field data:', clientFieldData); // Log client field data
      res.status(200).json(clientFieldData);
  } catch (error) {
      console.error('Error fetching client field data:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});

// admin dashboard 

router.get('/admin/:id', authenticateToken, async (req, res) => {
  try {
      const admin = await Admin.findById(req.params.id).select('username');
      if (!admin) {
          return res.status(404).json({ error: 'Admin not found' });
      }
      res.status(200).json(admin);
  } catch (error) {
      console.error('Error fetching admin details:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});
router.get('/visitors-count', authenticateToken, async (req, res) => {
  try {
    const walkInClientsCount = await Client.countDocuments({ status: 'walk_in' });
    const customersCount = await Client.countDocuments({ status: 'customer' });
    const qualifiedLeadCount = await Client.countDocuments({ status: 'qualified_lead' });
    const onHoldClientsCount = await Client.countDocuments({ status: 'on_hold' });
    const businessProposalCount = await Client.countDocuments({ status: 'business_proposal' });

    res.status(200).json({
      walkInClients: walkInClientsCount,
      customers: customersCount,
      qualifiedLead: qualifiedLeadCount,
      onHoldClients: onHoldClientsCount,
      businessProposal: businessProposalCount,
    });
  } catch (error) {
    console.error('Error fetching visitor counts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/visitors', authenticateToken, async (req, res) => {
  try {
    const clients = await Client.find().select('name companyName domain approved');
    res.status(200).json(clients);
  } catch (error) {
    console.error('Error fetching visitors:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/visitor/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const visitor = await Client.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!visitor) {
      return res.status(404).json({ error: 'Visitor not found' });
    }
    res.status(200).json(visitor);
  } catch (error) {
    console.error('Error updating visitor status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/clients-count', authenticateToken, async (req, res) => {
  try {
    const clientsCount = await Client.countDocuments();
    res.status(200).json({ clientsCount });
  } catch (error) {
    console.error('Error fetching clients count:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



router.get('/clients', authenticateToken, async (req, res) => {
  try {
    const clients = await Client.find().select('name companyName status');
    res.status(200).json(clients);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/visitors/:id', authenticateToken, async (req, res) => {
  console.log('Received request for visitor ID:', req.params.id);
  try {
      const visitor = await Client.findById(req.params.id);
      if (!visitor) {
          console.log('Visitor not found for ID:', req.params.id);
          return res.status(404).json({ error: 'Visitor not found' });
      }
      res.status(200).json(visitor);
  } catch (error) {
      console.error('Error fetching visitor details:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});


// Define a new route for fetching detailed visitor data
router.get('/api/visitorDetails/:id', authenticateToken, async (req, res) => {
  console.log('Received request for detailed visitor data for ID:', req.params.id);
  try {
      const visitor = await Client.findById(req.params.id).populate('projects products services solutions');
      if (!visitor) {
          console.log('Visitor not found for ID:', req.params.id);
          return res.status(404).json({ error: 'Visitor not found' });
      }
      console.log('Detailed visitor data found:', visitor);
      res.status(200).json(visitor);
  } catch (error) {
      console.error('Error fetching detailed visitor data:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});



app.post('/api/visitors/:id/details', authenticateToken, async (req, res) => {
  try {
      console.log('Request body:', req.body);

      const visitorId = req.params.id;
      const { projects, products, services, solutions } = req.body;

      const updatedVisitor = await Client.findByIdAndUpdate(
          visitorId,
          { projects, products, services, solutions },
          { new: true, runValidators: true }
      );

      if (!updatedVisitor) {
          return res.status(404).json({ error: 'Visitor not found' });
      }

      res.status(200).json({ message: 'Data saved successfully', visitor: updatedVisitor });
  } catch (error) {
      console.error('Error saving visitor details:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
  }
});
// Route to update additional client field data
router.post('/api/visitors/:id/details/more', authenticateToken, async (req, res) => {
  try {
      const visitorId = req.params.id;
      const { financialCapacity, annualTurnover, netWorth, decisionMakers, leadTime, leadTimeUnit } = req.body;

      // Find the visitor in MongoDB by visitor ID
      const client = await Client.findById(visitorId);

      if (!client) {
          return res.status(404).json({ error: 'Client not found' });
      }

      // Update client's financial information
      client.financialCapacity = financialCapacity;
      client.annualTurnover = annualTurnover;
      client.netWorth = netWorth;
      client.decisionMakers = decisionMakers;
      client.leadTime = {
          value: leadTime,
          unit: leadTimeUnit
      };

      // Save the updated client document
      await client.save();

      res.status(200).json({ message: 'Data saved successfully' });
  } catch (error) {
      console.error('Error saving client field data:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/', router); // Mount the router



// Serve index.html as default route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
