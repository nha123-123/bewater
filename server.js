const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const nodemailer = require('nodemailer');
const app = express();
app.use(express.json({ limit: '10mb' })); // Tăng giới hạn payload lên 10MB
app.use(cors());

// Phục vụ file tĩnh từ thư mục uploads
app.use('/uploads', express.static('uploads'));


// ✅ ĐÚNG (Không còn dấu ngoặc nhọn < > nữa):
const uri = "mongodb+srv://myUser:MySecurePassword123@cluster0.0nluv4h.mongodb.net/water_order_db?appName=Cluster0";

// const uri = 'mongodb://localhost:27017';
// const dbName = 'water_order_db';
// let db;

const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

// Kết nối MongoDB
MongoClient.connect(uri)
  .then(client => {
    db = client.db(dbName);
    console.log('Connected to MongoDB');
  })
  .catch(err => console.error('MongoDB connection error:', err));

// ...existing code...

// Middleware kiểm tra token (sửa để tìm user theo token)
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Thiếu token xác thực' });
  }
  try {
    const usersCollection = db.collection('users');
    // Tìm user theo token field
    let user = await usersCollection.findOne({ token });
    // Nếu dev local và chưa lưu token trên user, fallback tìm user mới nhất (chỉ dev)
    if (!user && token.startsWith('fake-jwt-token-')) {
      user = await usersCollection.findOne({}, { sort: { createdAt: -1 } });
    }
    if (!user) return res.status(401).json({ error: 'Không tìm thấy người dùng' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Lỗi xác thực: ' + err.message });
  }
};

// Đăng ký: tạo token và lưu vào document user
app.post('/auth/register', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  const { email, password, name, role, age, gender, address, phone, avatar } = req.body;
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'Thiếu email, mật khẩu, tên hoặc vai trò' });
  }
  try {
    const usersCollection = db.collection('users');
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email đã được sử dụng' });
    }
    const token = 'fake-jwt-token-' + Date.now();
    const user = { 
      email, 
      password, 
      name, 
      role, 
      age: age || null,
      gender: gender || null,
      address: address || null,
      phone: phone || null,
      avatar: avatar || null,
      createdAt: new Date(),
      status: role === 'staff' ? 'pending' : 'approved',
      token, // Lưu token vào user
    };
    const result = await usersCollection.insertOne(user);
    res.json({ 
      message: 'Đăng ký thành công', 
      token, 
      user: { id: result.insertedId.toString(), ...user } 
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Đăng nhập: tạo token, cập nhật document user với token
app.post('/auth/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
  }
  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email, password });
    if (!user) {
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
    }
    const status = user.status || (user.role === 'staff' ? 'pending' : 'approved');
    if (status !== 'approved') {
      return res.status(403).json({ error: 'Tài khoản đang chờ duyệt' });
    }
    const token = 'fake-jwt-token-' + Date.now();
    // Lưu token lên user document
    await usersCollection.updateOne({ _id: user._id }, { $set: { token } });
    res.json({ 
      message: 'Đăng nhập thành công', 
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        age: user.age?.toString(),
        gender: user.gender,
        address: user.address,
        phone: user.phone,
        avatar: user.avatar,
        createdAt: user.createdAt,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Duyệt nhân viên
app.put('/api/staff/approve/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'approved' hoặc 'rejected'
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Trạng thái không hợp lệ, chỉ chấp nhận "approved" hoặc "rejected"' });
  }
  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(id) });
    if (!user) {
      return res.status(404).json({ error: 'Nhân viên không tồn tại' });
    }
    if (user.role !== 'staff') {
      return res.status(403).json({ error: 'Chỉ có thể duyệt nhân viên staff' });
    }
    if (user.status === status) {
      return res.status(400).json({ error: `Trạng thái đã là ${status}` });
    }
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Nhân viên không tồn tại' });
    }
    res.status(200).json({ message: `Đã cập nhật trạng thái thành ${status}` });
  } catch (err) {
    console.error('Approve staff error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});


// Đăng nhập
// app.post('/auth/login', async (req, res) => {
//   if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
//   const { email, password } = req.body;
//   if (!email || !password) {
//     return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
//   }
//   try {
//     const usersCollection = db.collection('users');
//     const user = await usersCollection.findOne({ email, password });
//     if (!user) {
//       return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
//     }
//     const token = 'fake-jwt-token-' + Date.now();
//     res.json({ message: 'Đăng nhập thành công', token, user: { id: user._id.toString(), email: user.email, name: user.name, role: user.role } });
//   } catch (err) {
//     console.error('Login error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });


// app.post('/auth/login', async (req, res) => {
//   if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
//   const { email, password } = req.body;
//   if (!email || !password) {
//     return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
//   }
//   try {
//     const usersCollection = db.collection('users');
//     const user = await usersCollection.findOne({ email, password });
//     if (!user) {
//       return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
//     }
//     // Xử lý status, mặc định approved cho admin/customer nếu không có
//     const status = user.status || (user.role === 'staff' ? 'pending' : 'approved');
//     if (status !== 'approved') {
//       return res.status(403).json({ error: 'Tài khoản đang chờ duyệt' });
//     }
//     const token = 'fake-jwt-token-' + Date.now();
//     res.json({ 
//       message: 'Đăng nhập thành công', 
//       token,
//       user: {
//         id: user._id.toString(),
//         email: user.email,
//         name: user.name,
//         role: user.role,
//         age: user.age?.toString(),
//         gender: user.gender,
//         address: user.address,
//         phone: user.phone,
//         avatar: user.avatar,
//         createdAt: user.createdAt,
//         status: user.status
//       }
//     });
//   } catch (err) {
//     console.error('Login error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });
// Lấy thông tin người dùng hiện tại
app.get('/auth/me', authenticateToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  try {
    const userId = req.user._id; // Giả định authenticateToken đã gắn user vào req
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        age: user.age?.toString(),
        gender: user.gender,
        address: user.address,
        phone: user.phone,
        avatar: user.avatar,
        createdAt: user.createdAt,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Cập nhật thông tin nhân viên
app.put('/api/staff/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { email, password, name } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Thiếu email hoặc tên' });
  }
  try {
    const usersCollection = db.collection('users');
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { email, ...(password ? { password } : {}), name } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Nhân viên không tồn tại' });
    }
    res.status(200).json({ message: 'Cập nhật thành công' });
  } catch (err) {
    console.error('Update staff error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Thêm endpoint GET /api/staff
app.get('/api/staff', authenticateToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  try {
    const usersCollection = db.collection('users');
    const staffList = await usersCollection
      .find({ role: 'staff' }) // Lọc chỉ nhân viên
      .project({ password: 0 }) // Loại bỏ trường password
      .toArray();
    res.status(200).json(staffList);
  } catch (err) {
    console.error('Get staff error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Tạo đơn hàng
// app.post('/api/orders', authenticateToken, async (req, res) => {
//   const { type, items, total, status, createdAt } = req.body;
//   if (!type || !items || !total || !status || !createdAt) {
//     return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
//   }
//   try {
//     const ordersCollection = db.collection('orders');
//     const menuCollection = db.collection('menu');
//     const inventoryCollection = db.collection('inventory');

//     console.log('Received order data:', req.body);

//     for (const item of items) {
//       const menuItem = await menuCollection.findOne({ _id: new ObjectId(item.menuId) });
//       if (!menuItem) {
//         console.warn(`Menu item not found for menuId: ${item.menuId}`);
//         continue;
//       }
//       console.log(`Menu item found for menuId ${item.menuId}:`, menuItem);

//       // Sử dụng toppingIds và toppingQuantities thay vì ingredients
//       if (menuItem.toppingIds && Array.isArray(menuItem.toppingIds) && menuItem.toppingQuantities && Array.isArray(menuItem.toppingQuantities)) {
//         const toppingIds = menuItem.toppingIds;
//         const toppingQuantities = menuItem.toppingQuantities;
//         for (let i = 0; i < toppingIds.length; i++) {
//           const inventoryId = toppingIds[i];
//           const quantity = (toppingQuantities[i] || 0) * item.quantity;
//           const inventoryItem = await inventoryCollection.findOne({ _id: new ObjectId(inventoryId) });
//           if (inventoryItem) {
//             console.log(`Reducing ${inventoryItem.name}: ${quantity}${inventoryItem.unit} (current: ${inventoryItem.quantity})`);
//             if (inventoryItem.quantity < quantity) {
//               return res.status(400).json({
//                 error: `Không đủ nguyên liệu ${inventoryItem.name} (${inventoryItem.quantity}${inventoryItem.unit} còn lại, cần ${quantity}${inventoryItem.unit})`
//               });
//             }
//             await inventoryCollection.updateOne(
//               { _id: new ObjectId(inventoryId) },
//               { $inc: { quantity: -quantity } }
//             );
//             console.log(`Reduced ${inventoryItem.name} by ${quantity}${inventoryItem.unit}`);
//           } else {
//             return res.status(400).json({ error: `Nguyên liệu với ID ${inventoryId} không tồn tại` });
//           }
//         }
//       } else {
//         console.warn(`No valid toppings found for menuId: ${item.menuId}`);
//       }
//     }

//     const result = await ordersCollection.insertOne({ type, items, total, status, createdAt });
//     res.status(201).json({ message: 'Đơn hàng được tạo', id: result.insertedId.toString() });
//   } catch (err) {
//     console.error('Create order error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });
// Tạo đơn hàng
// app.post('/api/orders', authenticateToken, async (req, res) => {
//   const { type, items, total, status, createdAt, voucherCode } = req.body;
//   if (!type || !items || !total || !status || !createdAt) {
//     return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
//   }
//   try {
//     const ordersCollection = db.collection('orders');
//     const menuCollection = db.collection('menu');
//     const combosCollection = db.collection('combos');
//     const inventoryCollection = db.collection('inventory');
//     const usersCollection = db.collection('users');

//     let finalTotal = total;
//     let voucher = null;

//     // ---- Xử lý voucher ----
//     if (voucherCode) {
//       const user = await usersCollection.findOne({ _id: req.user._id });
//       if (!user?.savedVouchers?.includes(voucherCode)) {
//         return res.status(400).json({ error: 'Voucher chưa được lưu hoặc đã dùng' });
//       }
//       voucher = await db.collection('vouchers').findOne({ code: voucherCode });
//       if (!voucher) {
//         return res.status(400).json({ error: 'Voucher không hợp lệ' });
//       }
//       if (voucher.expiry && new Date(voucher.expiry) < new Date()) {
//         return res.status(400).json({ error: 'Voucher đã hết hạn' });
//       }
//       finalTotal = Math.round(total * (1 - voucher.discount / 100));
//       await usersCollection.updateOne(
//         { _id: req.user._id },
//         { $pull: { savedVouchers: voucherCode } }
//       );
//     }

//     // ---- Xử lý giảm kho topping ----
//     for (const item of items) {
//       // Nếu là combo thì xử lý từng món trong combo
//       if (item.comboId) {
//         const combo = await combosCollection.findOne({ _id: new ObjectId(item.comboId) });
//         if (!combo) continue;
//         for (const comboItem of combo.items || []) {
//           const menuItem = await menuCollection.findOne({ _id: new ObjectId(comboItem.menuId) });
//           if (!menuItem) continue;
//           if (menuItem.toppingIds && Array.isArray(menuItem.toppingIds) &&
//               menuItem.toppingQuantities && Array.isArray(menuItem.toppingQuantities)) {
//             const toppingIds = menuItem.toppingIds;
//             const toppingQuantities = menuItem.toppingQuantities;
//             for (let i = 0; i < toppingIds.length; i++) {
//               const inventoryId = toppingIds[i];
//               // Số lượng topping = số lượng combo * số lượng món trong combo
//               const quantity = (toppingQuantities[i] || 0) * (item.quantity || 1) * (comboItem.quantity || 1);
//               const inventoryItem = await inventoryCollection.findOne({ _id: new ObjectId(inventoryId) });
//               if (inventoryItem) {
//                 if (inventoryItem.quantity < quantity) {
//                   return res.status(400).json({
//                     error: `Không đủ nguyên liệu ${inventoryItem.name} (${inventoryItem.quantity}${inventoryItem.unit} còn lại, cần ${quantity}${inventoryItem.unit})`
//                   });
//                 }
//                 await inventoryCollection.updateOne(
//                   { _id: new ObjectId(inventoryId) },
//                   { $inc: { quantity: -quantity } }
//                 );
//               } else {
//                 return res.status(400).json({ error: `Nguyên liệu với ID ${inventoryId} không tồn tại` });
//               }
//             }
//           }
//         }
//       } else if (item.menuId) {
//         // Nếu là sản phẩm thường
//         const menuItem = await menuCollection.findOne({ _id: new ObjectId(item.menuId) });
//         if (!menuItem) continue;
//         if (menuItem.toppingIds && Array.isArray(menuItem.toppingIds) &&
//             menuItem.toppingQuantities && Array.isArray(menuItem.toppingQuantities)) {
//           const toppingIds = menuItem.toppingIds;
//           const toppingQuantities = menuItem.toppingQuantities;
//           for (let i = 0; i < toppingIds.length; i++) {
//             const inventoryId = toppingIds[i];
//             const quantity = (toppingQuantities[i] || 0) * item.quantity;
//             const inventoryItem = await inventoryCollection.findOne({ _id: new ObjectId(inventoryId) });
//             if (inventoryItem) {
//               if (inventoryItem.quantity < quantity) {
//                 return res.status(400).json({
//                   error: `Không đủ nguyên liệu ${inventoryItem.name} (${inventoryItem.quantity}${inventoryItem.unit} còn lại, cần ${quantity}${inventoryItem.unit})`
//                 });
//               }
//               await inventoryCollection.updateOne(
//                 { _id: new ObjectId(inventoryId) },
//                 { $inc: { quantity: -quantity } }
//               );
//             } else {
//               return res.status(400).json({ error: `Nguyên liệu với ID ${inventoryId} không tồn tại` });
//             }
//           }
//         }
//       }
//     }

//     // ---- Lưu đơn hàng ----
//     const result = await ordersCollection.insertOne({
//       type,
//       items,
//       total: finalTotal,
//       status,
//       createdAt,
//       voucherCode: voucherCode || null,
//       voucherDiscount: voucher ? voucher.discount : 0,
//     });

//     res.status(201).json({ message: 'Đơn hàng được tạo', id: result.insertedId.toString() });
//   } catch (err) {
//     console.error('Create order error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });
app.post('/api/orders', authenticateToken, async (req, res) => {
  const { type, items, total, status, createdAt, voucherCode } = req.body;
  if (!type || !items || !total || !status || !createdAt) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }

  try {
    const ordersCollection = db.collection('orders');
    const menuCollection = db.collection('menu');
    const combosCollection = db.collection('combos');
    const inventoryCollection = db.collection('inventory');
    const usersCollection = db.collection('users');

    let finalTotal = total;
    let voucher = null;

    // ---- Xử lý voucher ----
    if (voucherCode) {
      const user = await usersCollection.findOne({ _id: req.user._id });
      if (!user?.savedVouchers?.includes(voucherCode)) {
        return res.status(400).json({ error: 'Voucher chưa được lưu hoặc đã dùng' });
      }

      voucher = await db.collection('vouchers').findOne({ code: voucherCode });
      if (!voucher) {
        return res.status(400).json({ error: 'Voucher không hợp lệ' });
      }

      if (voucher.expiry && new Date(voucher.expiry) < new Date()) {
        return res.status(400).json({ error: 'Voucher đã hết hạn' });
      }

      finalTotal = Math.round(total * (1 - voucher.discount / 100));

      await usersCollection.updateOne(
        { _id: req.user._id },
        { $pull: { savedVouchers: voucherCode } }
      );
    }

    // ---- Xử lý giảm kho topping ----
    for (const item of items) {
      if (item.comboId) {
        const combo = await combosCollection.findOne({ _id: new ObjectId(item.comboId) });
        if (!combo) continue;

        for (const comboItem of combo.items || []) {
          const menuItem = await menuCollection.findOne({ _id: new ObjectId(comboItem.menuId) });
          if (!menuItem) continue;

          if (menuItem.toppingIds && Array.isArray(menuItem.toppingIds) &&
              menuItem.toppingQuantities && Array.isArray(menuItem.toppingQuantities)) {

            const toppingIds = menuItem.toppingIds;
            const toppingQuantities = menuItem.toppingQuantities;

            for (let i = 0; i < toppingIds.length; i++) {
              const inventoryId = toppingIds[i];
              const quantity = (toppingQuantities[i] || 0) * (item.quantity || 1) * (comboItem.quantity || 1);
              const inventoryItem = await inventoryCollection.findOne({ _id: new ObjectId(inventoryId) });

              if (inventoryItem) {
                if (inventoryItem.quantity < quantity) {
                  return res.status(400).json({
                    error: `Không đủ nguyên liệu ${inventoryItem.name} (${inventoryItem.quantity}${inventoryItem.unit} còn lại, cần ${quantity}${inventoryItem.unit})`
                  });
                }

                await inventoryCollection.updateOne(
                  { _id: new ObjectId(inventoryId) },
                  { $inc: { quantity: -quantity } }
                );
              } else {
                return res.status(400).json({ error: `Nguyên liệu với ID ${inventoryId} không tồn tại` });
              }
            }
          }
        }
      } else if (item.menuId) {
        const menuItem = await menuCollection.findOne({ _id: new ObjectId(item.menuId) });
        if (!menuItem) continue;

        if (menuItem.toppingIds && Array.isArray(menuItem.toppingIds) &&
            menuItem.toppingQuantities && Array.isArray(menuItem.toppingQuantities)) {

          const toppingIds = menuItem.toppingIds;
          const toppingQuantities = menuItem.toppingQuantities;

          for (let i = 0; i < toppingIds.length; i++) {
            const inventoryId = toppingIds[i];
            const quantity = (toppingQuantities[i] || 0) * item.quantity;
            const inventoryItem = await inventoryCollection.findOne({ _id: new ObjectId(inventoryId) });

            if (inventoryItem) {
              if (inventoryItem.quantity < quantity) {
                return res.status(400).json({
                  error: `Không đủ nguyên liệu ${inventoryItem.name} (${inventoryItem.quantity}${inventoryItem.unit} còn lại, cần ${quantity}${inventoryItem.unit})`
                });
              }

              await inventoryCollection.updateOne(
                { _id: new ObjectId(inventoryId) },
                { $inc: { quantity: -quantity } }
              );
            } else {
              return res.status(400).json({ error: `Nguyên liệu với ID ${inventoryId} không tồn tại` });
            }
          }
        }
      }
    }

    // ---- Lưu đơn hàng (ĐÃ THÊM userId) ----
    const result = await ordersCollection.insertOne({
      type,
      items,
      total: finalTotal,
      status,
      createdAt,
      voucherCode: voucherCode || null,
      voucherDiscount: voucher ? voucher.discount : 0,
      userId: req.user._id, // ✅ Thêm dòng này để liên kết đơn hàng với người dùng
    });

    res.status(201).json({
      message: 'Đơn hàng được tạo thành công',
      id: result.insertedId.toString(),
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});


// Tạo voucher đã lưu voà nười dùng
app.post('/api/vouchers/save', authenticateToken, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Thiếu mã voucher' });
  try {
    const voucher = await db.collection('vouchers').findOne({ code });
    if (!voucher) return res.status(404).json({ error: 'Voucher không tồn tại' });
    const usersCollection = db.collection('users');
    await usersCollection.updateOne(
      { _id: req.user._id },
      { $addToSet: { savedVouchers: code } }
    );
    res.status(200).json({ message: 'Đã lưu voucher vào tài khoản' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Lấy danh sách voucher đã lưu của người dùng
app.get('/api/vouchers/saved', authenticateToken, async (req, res) => {
  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ _id: req.user._id });
    const codes = user?.savedVouchers || [];
    const vouchers = await db.collection('vouchers').find({ code: { $in: codes } }).toArray();
    res.status(200).json(vouchers.map(v => ({ ...v, _id: v._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách đơn hàng
// app.get('/api/orders', authenticateToken, async (req, res) => {
//   if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
//   try {
//     const ordersCollection = db.collection('orders');
//     // Cho phép cả admin và staff đều lấy được danh sách đơn hàng
//     // Nếu là staff, có thể lọc theo assignedStaffId nếu muốn, còn mặc định trả về tất cả
//     const orders = await ordersCollection.find({}).toArray();
//     const formattedOrders = orders.map(order => ({
//       ...order,
//       _id: order._id.toString(),
//     }));
//     res.status(200).json(formattedOrders);
//   } catch (err) {
//     console.error('Fetch orders error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });
// ...existing code...

// Thay thế hoặc thêm phần orders (sửa GET /api/orders và thêm PUT /api/orders/:id/status, GET /api/orders/assigned)
app.get('/api/orders', authenticateToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  try {
    // Admin xem tất cả, staff chỉ xem các đơn chưa hoàn thành hoặc được giao cho họ
    if (req.user && req.user.role === 'admin') {
      const orders = await db.collection('orders').find({}).toArray();
      return res.status(200).json(orders.map(o => ({ ...o, _id: o._id.toString() })));
    } else if (req.user && req.user.role === 'staff') {
      const staffId = req.user._id;
      const orders = await db.collection('orders')
        .find({
          $or: [
            { assignedStaffId: staffId },
            { status: { $in: ['pending', 'accepted'] } } // staff can view pending/accepted
          ]
        })
        .toArray();
      return res.status(200).json(orders.map(o => ({ ...o, _id: o._id.toString() })));
    } else {
      return res.status(403).json({ error: 'Không có quyền xem danh sách đơn hàng' });
    }
  } catch (err) {
    console.error('Fetch orders error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Lấy đơn được giao cho staff hiện tại
app.get('/api/orders/assigned', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    if (!req.user || req.user.role !== 'staff') return res.status(403).json({ error: 'Chỉ staff mới truy cập' });
    const staffId = req.user._id;
    const orders = await db.collection('orders').find({ assignedStaffId: staffId }).toArray();
    res.status(200).json(orders.map(o => ({ ...o, _id: o._id.toString() })));
  } catch (err) {
    console.error('Fetch assigned orders error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Cập nhật trạng thái đơn (staff nhận/khởi chạy/hoàn thành)
app.put('/api/orders/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status, assignToMe } = req.body; // status: 'accepted'|'in_progress'|'completed'|'cancelled'
  try {
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'orderId không hợp lệ' });
    const ordersCollection = db.collection('orders');
    const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    // Quyền: admin mọi lúc; staff chỉ có thể thao tác với đơn được giao hoặc pending (khi assignToMe)
    // if (req.user.role === 'staff') {
    //   if (assignToMe) {
    //     // staff nhận đơn: gán assignedStaffId và set status = accepted (or status provided)
    //     await ordersCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { assignedStaffId: req.user._id, status: status || 'accepted', updatedAt: new Date() } }
    //     );
    //   } else {
    //     // nếu staff không được giao và không phải assigned, chặn
    //     if (!order.assignedStaffId || order.assignedStaffId.toString() !== req.user._id.toString()) {
    //       return res.status(403).json({ error: 'Bạn không được phép thay đổi đơn này' });
    //     }
    //     await ordersCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { status: status, updatedAt: new Date() } }
    //     );
    //   }
    // }// ...existing code...
if (req.user.role === 'staff') {
  if (assignToMe) {
    // staff nhận đơn: gán assignedStaffId và set status = accepted (or status provided)
    await ordersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { assignedStaffId: req.user._id, status: status || 'accepted', updatedAt: new Date() } }
    );
  } else {
    // Cho phép staff cập nhật trạng thái bất kỳ đơn nào
    await ordersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: status, updatedAt: new Date() } }
    );
  }
}
     else if (req.user.role === 'admin') {
      await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, ...(assignToMe ? { assignedStaffId: req.user._id } : {}), updatedAt: new Date() } }
      );
    } else {
      return res.status(403).json({ error: 'Không có quyền' });
    }

    const updated = await ordersCollection.findOne({ _id: new ObjectId(id) });
    res.status(200).json({ message: 'Cập nhật trạng thái thành công', order: { ...updated, _id: updated._id.toString() } });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// ...existing code...

// Xóa đơn hàng
app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
  const orderId = req.params.id;
  try {
    if (!ObjectId.isValid(orderId)) {
      console.error('Invalid orderId:', orderId);
      return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });
    }
    const ordersCollection = db.collection('orders');
    const order = await ordersCollection.findOne({ _id: new ObjectId(orderId) });
    if (!order) {
      console.error('Order not found for ID:', orderId);
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
    // Kiểm tra trạng thái (tuỳ chọn, nếu muốn hạn chế xóa hóa đơn đã thanh toán)
    if (order.status === 'completed') {
      console.warn('Attempt to delete completed order:', orderId);
      return res.status(403).json({ error: 'Không thể xóa hóa đơn đã thanh toán' });
    }
    const result = await ordersCollection.deleteOne({ _id: new ObjectId(orderId) });
    if (result.deletedCount === 1) {
      res.status(200).json({ message: 'Đơn hàng đã được xóa' });
    } else {
      console.error('Delete failed for orderId:', orderId);
      res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }
  } catch (err) {
    console.error('Delete order error:', err, 'orderId:', orderId);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Lấy danh sách món ăn
app.get('/api/menu', authenticateToken, async (req, res) => {
  try {
    const menuCollection = db.collection('menu');
    const categoriesCollection = db.collection('categories');
    const danhmuc = req.query.danhmuc;
    let filter = {};
    if (danhmuc) {
      // Tìm danh mục theo _id hoặc tên
      const category = await categoriesCollection.findOne({
        $or: [{ _id: ObjectId.isValid(danhmuc) ? new ObjectId(danhmuc) : null }, { name: danhmuc }],
      });
      if (category) {
        filter.danhmuc = category.name; // Sử dụng tên danh mục để lọc
      }
    }
    const items = await menuCollection.find(filter).toArray();
    const categories = await categoriesCollection.find().toArray();
    const categoryMap = new Map(categories.map(cat => [cat.name, cat._id.toString()]));
    const formattedItems = items.map(item => ({
      ...item,
      _id: item._id.toString(),
      danhmuc: categoryMap.get(item.danhmuc) || item.danhmuc,
    }));
    res.status(200).json(formattedItems);
  } catch (err) {
    console.error('Fetch menu error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Thêm món ăn

app.post('/api/menu', authenticateToken, upload.single('image'), async (req, res) => {
  const { name, price, danhmuc, toppingIds, toppingQuantities } = req.body;
  if (!name || !price || !danhmuc) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const categoriesCollection = db.collection('categories');
    let category;
    if (ObjectId.isValid(danhmuc)) {
      category = await categoriesCollection.findOne({ _id: new ObjectId(danhmuc) });
    } else {
      category = await categoriesCollection.findOne({ name: danhmuc });
    }
    if (!category) {
      return res.status(400).json({ error: 'Danh mục không hợp lệ' });
    }
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    const parsedToppingIds = JSON.parse(toppingIds || '[]');
    const parsedToppingQuantities = JSON.parse(toppingQuantities || '[]').map(q => parseFloat(q) || 0);
    const result = await db.collection('menu').insertOne({
      name,
      price,
      danhmuc: category.name, // Sử dụng name của danh mục
      toppingIds: parsedToppingIds,
      toppingQuantities: parsedToppingQuantities,
      image,
    });
    res.status(201).json({ message: 'Thêm món thành công', id: result.insertedId.toString() });
  } catch (err) {
    console.error('Create menu item error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/reduce', authenticateToken, async (req, res) => {
  const { updates } = req.body;
  try {
    const inventoryCollection = db.collection('inventory');
    for (const update of updates) {
      const { ingredients } = update;
      for (const ing of ingredients) {
        const { id, quantity } = ing;
        await inventoryCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { quantity: -quantity } },
          { upsert: false }
        );
      }
    }
    res.status(200).json({ message: 'Kho đã được cập nhật' });
  } catch (err) {
    console.error('Reduce inventory error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Cập nhật món ăn
app.put('/api/menu/:id', authenticateToken, upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { name, price, danhmuc, toppingIds, toppingQuantities } = req.body;
  if (!name || !price || !danhmuc) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const categoriesCollection = db.collection('categories');
    const category = await categoriesCollection.findOne({ _id: ObjectId.isValid(danhmuc) ? new ObjectId(danhmuc) : null });
    const existingItem = await db.collection('menu').findOne({ _id: new ObjectId(id) });
    if (!existingItem) {
      return res.status(404).json({ error: 'Món không tồn tại' });
    }
    const image = req.file ? `/uploads/${req.file.filename}` : existingItem.image;
    const parsedToppingIds = JSON.parse(toppingIds || '[]');
    const parsedToppingQuantities = JSON.parse(toppingQuantities || '[]').map(q => parseFloat(q) || 0);
    const result = await db.collection('menu').updateOne(
      { _id: new ObjectId(id) },
      { $set: { name, price, danhmuc: category ? category.name : danhmuc, toppingIds: parsedToppingIds, toppingQuantities: parsedToppingQuantities, image } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Món không tồn tại' });
    }
    res.status(200).json({ message: 'Cập nhật món thành công' });
  } catch (err) {
    console.error('Update menu item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Xóa món ăn
app.delete('/api/menu/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existingItem = await db.collection('menu').findOne({ _id: new ObjectId(id) });
    if (!existingItem) {
      return res.status(404).json({ error: 'Món không tồn tại' });
    }
    if (existingItem.image && fs.existsSync(`./${existingItem.image}`)) {
      fs.unlinkSync(`./${existingItem.image}`);
      console.log(`Deleted image file: ${existingItem.image}`);
    }
    const result = await db.collection('menu').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Món không tồn tại' });
    }
    res.status(200).json({ message: 'Xóa món thành công' });
  } catch (err) {
    console.error('Delete menu item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách danh mục
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await db.collection('categories').find().toArray();
    const formattedCategories = categories.map(category => ({
      ...category,
      _id: category._id.toString(),
    }));
    res.status(200).json(formattedCategories);
  } catch (err) {
    console.error('Fetch categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Thêm danh mục
app.post('/api/categories', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Tên danh mục không hợp lệ' });
  }
  try {
    const result = await db.collection('categories').insertOne({ name });
    res.status(201).json({ message: 'Thêm danh mục thành công', id: result.insertedId.toString() });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cập nhật danh mục
app.put('/api/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Tên danh mục không hợp lệ' });
  }
  try {
    const result = await db.collection('categories').updateOne(
      { _id: new ObjectId(id) },
      { $set: { name } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Danh mục không tồn tại' });
    }
    res.status(200).json({ message: 'Cập nhật danh mục thành công' });
  } catch (err) {
    console.error('Update category error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Xóa danh mục
app.delete('/api/categories/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.collection('categories').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Danh mục không tồn tại' });
    }
    res.status(200).json({ message: 'Xóa danh mục thành công' });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Lấy danh sách nguyên liệu
app.get('/api/inventory', authenticateToken, async (req, res) => {
  try {
    const items = await db.collection('inventory').find({}).toArray();
    const formattedItems = items
      .map(item => ({
        ...item,
        _id: item._id?.toString() ?? '',
        name: item.name ?? 'Không tên',
        quantity: item.quantity ?? 0.0,
        threshold: item.threshold ?? 0.0,
        unit: item.unit ?? 'Không xác định',
      }))
      .filter(item => item._id !== ''); // Đảm bảo lọc các item có _id hợp lệ
    res.status(200).json(formattedItems);
  } catch (err) {
    console.error('Fetch inventory error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Thêm nguyên liệu
app.post('/api/inventory', authenticateToken, async (req, res) => {
  const { name, quantity, threshold, unit } = req.body;
  if (!name || quantity == null || threshold == null || !unit) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const result = await db.collection('inventory').insertOne({
      name,
      quantity,
      threshold,
      unit,
    });
    res.status(201).json({ message: 'Thêm nguyên liệu thành công', id: result.insertedId.toString() });
  } catch (err) {
    console.error('Create inventory item error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Cập nhật nguyên liệu
app.put('/api/inventory/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, quantity, threshold, unit } = req.body;
  if (!name || quantity == null || threshold == null || !unit) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const result = await db.collection('inventory').updateOne(
      { _id: new ObjectId(id) },
      { $set: { name, quantity, threshold, unit } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Nguyên liệu không tồn tại' });
    }
    res.status(200).json({ message: 'Cập nhật nguyên liệu thành công' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Xóa nguyên liệu
app.delete('/api/inventory/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    if (!ObjectId.isValid(id)) {
      console.error('Invalid inventory item ID:', id);
      return res.status(400).json({ error: 'ID nguyên liệu không hợp lệ' });
    }
    const result = await db.collection('inventory').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      console.error('Inventory item not found for ID:', id);
      return res.status(404).json({ error: 'Không tìm thấy nguyên liệu' });
    }
    res.status(200).json({ message: 'Xóa nguyên liệu thành công' });
  } catch (err) {
    console.error('Delete inventory item error:', err, 'id:', id);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});


// Endpoint để lấy danh sách khách hàng
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const usersCollection = db.collection('users');
    const customers = await usersCollection
      .find({ role: 'customer' })
      .project({ password: 0 }) // Loại bỏ trường password khỏi kết quả
      .toArray();

    // Chuyển đổi _id thành string để phù hợp với client
    const formattedCustomers = customers.map(customer => ({
      ...customer,
      _id: customer._id.toString(),
    }));

    res.status(200).json(formattedCustomers);
  } catch (err) {
    console.error('Fetch customers error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// Lấy chi tiết khách hàng
app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const usersCollection = db.collection('users');
    const customer = await usersCollection.findOne({ _id: new ObjectId(req.params.id), role: 'customer' }, { projection: { password: 0 } });

    if (!customer) return res.status(404).json({ error: 'Khách hàng không tồn tại' });

    res.status(200).json({ ...customer, _id: customer._id.toString() });
  } catch (err) {
    console.error('Fetch customer detail error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Cập nhật thông tin khách hàng
app.put('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { name, email, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

    const updateData = { name, email };
    if (password) {
      // Hash mật khẩu trước khi lưu (giả định sử dụng bcrypt)
      const bcrypt = require('bcrypt');
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      updateData.password = hashedPassword;
    }

    const usersCollection = db.collection('users');
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(req.params.id), role: 'customer' },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Khách hàng không tồn tại' });
    res.status(200).json({ message: 'Cập nhật thành công' });
  } catch (err) {
    console.error('Update customer error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Xóa khách hàng
app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const usersCollection = db.collection('users');
    const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id), role: 'customer' });

    if (result.deletedCount === 0) return res.status(404).json({ error: 'Khách hàng không tồn tại' });
    res.status(200).json({ message: 'Xóa thành công' });
  } catch (err) {
    console.error('Delete customer error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Gửi thông báo cho khách hàng cụ thể
app.post('/api/notifications/customer/:id', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { message } = req.body;
    const customerId = req.params.id;
    if (!message) return res.status(400).json({ error: 'Thiếu nội dung thông báo' });

    // Lưu vào collection notifications
    await db.collection('notifications').insertOne({
      userId: new ObjectId(customerId),
      message,
      createdAt: new Date(),
      from: req.user._id,
    });

    res.status(201).json({ message: 'Thông báo đã được gửi' });
  } catch (err) {
    console.error('Send notification error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await db.collection('notifications')
      .find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json(notifications.map(n => ({
      ...n,
      _id: n._id.toString(),
      createdAt: n.createdAt,
      message: n.message,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Thêm sản phẩm vào giỏ hàng
// app.post('/api/cart/add', authenticateToken, async (req, res) => {
//   try {
//     if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

//     const { productId, quantity } = req.body;
//     console.log('Request body:', req.body); // Debug log
//     console.log('User ID:', req.user._id); // Debug log

//     if (!ObjectId.isValid(productId) || quantity < 1) {
//       return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
//     }

//     const menuCollection = db.collection('menu');
//     const cartsCollection = db.collection('carts');
//     const product = await menuCollection.findOne({ _id: new ObjectId(productId) });

//     console.log('Product found:', product); // Debug log

//     if (!product) {
//       return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
//     }

//     const cart = await cartsCollection.findOne({ userId: req.user._id });
//     if (cart) {
//       const itemIndex = cart.items.findIndex(item => item.menuId.toString() === productId);
//       if (itemIndex >= 0) {
//         await cartsCollection.updateOne(
//           { userId: req.user._id, 'items.menuId': new ObjectId(productId) },
//           { $inc: { 'items.$.quantity': quantity } }
//         );
//       } else {
//         await cartsCollection.updateOne(
//           { userId: req.user._id },
//           {
//             $push: {
//               items: {
//                 menuId: new ObjectId(productId),
//                 name: product.name,
//                 price: product.price,
//                 quantity: quantity,
//                 image: product.image,
//                 toppingIds: product.toppingIds || [],
//                 toppingQuantities: product.toppingQuantities || [],
//               },
//             },
//           }
//         );
//       }
//     } else {
//       await cartsCollection.insertOne({
//         userId: req.user._id,
//         items: [
//           {
//             menuId: new ObjectId(productId),
//             name: product.name,
//             price: product.price,
//             quantity: quantity,
//             image: product.image,
//             toppingIds: product.toppingIds || [],
//             toppingQuantities: product.toppingQuantities || [],
//           },
//         ],
//       });
//     }

//     res.status(200).json({ message: 'Thêm vào giỏ hàng thành công' });
//   } catch (err) {
//     console.error('Add to cart error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });
app.post('/api/cart/add', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { productId, quantity, comboId } = req.body;
    if ((!ObjectId.isValid(productId) && !ObjectId.isValid(comboId)) || quantity < 1) {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const menuCollection = db.collection('menu');
    const combosCollection = db.collection('combos');
    const cartsCollection = db.collection('carts');
    let product = null;
    let isCombo = false;

    if (comboId && ObjectId.isValid(comboId)) {
      product = await combosCollection.findOne({ _id: new ObjectId(comboId) });
      isCombo = true;
    } else {
      product = await menuCollection.findOne({ _id: new ObjectId(productId) });
    }

    if (!product) {
      return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
    }

    const cart = await cartsCollection.findOne({ userId: req.user._id });
    const itemData = isCombo
      ? {
          comboId: product._id,
          name: product.name,
          price: product.price,
          quantity,
          image: product.image,
          items: product.items || [],
        }
      : {
          menuId: product._id,
          name: product.name,
          price: product.price,
          quantity,
          image: product.image,
          toppingIds: product.toppingIds || [],
          toppingQuantities: product.toppingQuantities || [],
        };

    if (cart) {
      // Kiểm tra nếu đã có combo trong giỏ thì tăng số lượng
      const itemIndex = cart.items.findIndex(item =>
        isCombo
          ? item.comboId?.toString() === product._id.toString()
          : item.menuId?.toString() === product._id.toString()
      );
      if (itemIndex >= 0) {
        await cartsCollection.updateOne(
          { userId: req.user._id, [`items.${isCombo ? 'comboId' : 'menuId'}`]: product._id },
          { $inc: { [`items.$.quantity`]: quantity } }
        );
      } else {
        await cartsCollection.updateOne(
          { userId: req.user._id },
          { $push: { items: itemData } }
        );
      }
    } else {
      await cartsCollection.insertOne({
        userId: req.user._id,
        items: [itemData],
      });
    }

    res.status(200).json({ message: 'Thêm vào giỏ hàng thành công' });
  } catch (err) {
    console.error('Add to cart error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Lấy danh sách giỏ hàng
app.get('/api/cart', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const cartsCollection = db.collection('carts');
    const cart = await cartsCollection.findOne({ userId: req.user._id });

    if (!cart || !cart.items) {
      return res.status(200).json({ items: [] });
    }

    const formattedItems = cart.items.map(item => {
      if (item.comboId) {
        // Nếu là combo
        return {
          comboId: item.comboId.toString(),
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          image: item.image,
          items: item.items || [],
        };
      } else {
        // Nếu là sản phẩm thường
        return {
          menuId: item.menuId.toString(),
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          image: item.image,
          toppingIds: item.toppingIds || [],
          toppingQuantities: item.toppingQuantities || [],
        };
      }
    });

    res.status(200).json({ items: formattedItems });
  } catch (err) {
    console.error('Fetch cart error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Cập nhật số lượng sản phẩm trong giỏ hàng
app.put('/api/cart/:itemId', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { itemId } = req.params;
    const { quantity } = req.body;

    if (!ObjectId.isValid(itemId) || quantity < 0) {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const cartsCollection = db.collection('carts');
    if (quantity === 0) {
      await cartsCollection.updateOne(
        { userId: req.user._id },
        { $pull: { items: { menuId: new ObjectId(itemId) } } }
      );
    } else {
      await cartsCollection.updateOne(
        { userId: req.user._id, 'items.menuId': new ObjectId(itemId) },
        { $set: { 'items.$.quantity': quantity } }
      );
    }

    res.status(200).json({ message: 'Cập nhật giỏ hàng thành công' });
  } catch (err) {
    console.error('Update cart error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Xóa giỏ hàng
app.delete('/api/cart', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const cartsCollection = db.collection('carts');
    await cartsCollection.deleteOne({ userId: req.user._id });
    res.status(200).json({ message: 'Xóa giỏ hàng thành công' });
  } catch (err) {
    console.error('Delete cart error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Lấy số lượng sản phẩm trong giỏ hàng
app.get('/api/cart/count', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const cartsCollection = db.collection('carts');
    const cart = await cartsCollection.findOne({ userId: req.user._id });

    if (!cart || !cart.items || !Array.isArray(cart.items)) {
      return res.status(200).json({ count: 0 });
    }

    const count = cart.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
    res.status(200).json({ count });
  } catch (err) {
    console.error('Fetch cart count error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});













// Thêm đánh giá
app.post('/api/reviews/add', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { productId, rating, comment } = req.body;
    console.log('Review request body:', { productId, rating, comment }); // Debug log
    console.log('User ID:', req.user._id); // Debug log

    if (!ObjectId.isValid(productId) || (rating == null && !comment)) {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const reviewsCollection = db.collection('reviews');
    
    // Chèn đánh giá mới mà không kiểm tra đánh giá hiện có
    await reviewsCollection.insertOne({
      productId: new ObjectId(productId),
      userId: req.user._id,
      rating: rating ?? 0,
      comment: comment || '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Cập nhật trung bình đánh giá trong menu
    const menuCollection = db.collection('menu');
    const reviews = await reviewsCollection.find({ productId: new ObjectId(productId) }).toArray();
    const avgRating =
      reviews.length > 0
        ? reviews.reduce((sum, review) => sum + (review.rating || 0), 0) / reviews.length
        : 0;
    console.log(`Updating menu rating for product ${productId}: ${avgRating}`); // Debug log

    await menuCollection.updateOne(
      { _id: new ObjectId(productId) },
      { $set: { rating: avgRating } }
    );

    res.status(200).json({ message: 'Gửi đánh giá thành công' });
  } catch (err) {
    console.error('Add review error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// app.post('/api/reviews/add', authenticateToken, async (req, res) => {
//   try {
//     if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

//     const { productId, rating, comment } = req.body;
//     console.log('Review request body:', { productId, rating, comment }); // Debug log
//     console.log('User ID:', req.user._id); // Debug log

//     if (!ObjectId.isValid(productId) || (rating == null && !comment)) {
//       return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
//     }

//     const reviewsCollection = db.collection('reviews');
//     const existingReview = await reviewsCollection.findOne({
//       productId: new ObjectId(productId),
//       userId: req.user._id,
//     });

//     if (existingReview) {
//       await reviewsCollection.updateOne(
//         { productId: new ObjectId(productId), userId: req.user._id },
//         {
//           $set: {
//             rating: rating ?? existingReview.rating,
//             comment: comment || existingReview.comment,
//             updatedAt: new Date(),
//           },
//         }
//       );
//     } else {
//       await reviewsCollection.insertOne({
//         productId: new ObjectId(productId),
//         userId: req.user._id,
//         rating: rating ?? 0,
//         comment: comment || '',
//         createdAt: new Date(),
//         updatedAt: new Date(),
//       });
//     }

//     // Cập nhật trung bình đánh giá trong menu
//     const menuCollection = db.collection('menu');
//     const reviews = await reviewsCollection.find({ productId: new ObjectId(productId) }).toArray();
//     const avgRating =
//       reviews.length > 0
//         ? reviews.reduce((sum, review) => sum + (review.rating || 0), 0) / reviews.length
//         : 0;
//     console.log(`Updating menu rating for product ${productId}: ${avgRating}`); // Debug log

//     await menuCollection.updateOne(
//       { _id: new ObjectId(productId) },
//       { $set: { rating: avgRating } }
//     );

//     res.status(200).json({ message: 'Gửi đánh giá thành công' });
//   } catch (err) {
//     console.error('Add review error:', err);
//     res.status(500).json({ error: 'Lỗi server: ' + err.message });
//   }
// });

// Lấy đánh giá của người dùng cho sản phẩm

app.get('/api/reviews/:productId', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { productId } = req.params;
    console.log('Fetching review for productId:', productId, 'User ID:', req.user._id); // Debug log

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({ error: 'productId không hợp lệ' });
    }

    const reviewsCollection = db.collection('reviews');
    const review = await reviewsCollection.findOne({
      productId: new ObjectId(productId),
      userId: req.user._id,
    });

    if (!review) {
      return res.status(200).json({ rating: 0, comment: '' });
    }

    res.status(200).json({
      rating: review.rating || 0,
      comment: review.comment || '',
    });
  } catch (err) {
    console.error('Fetch review error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Lấy tất cả đánh giá của sản phẩm
app.get('/api/reviews/product/:productId', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { productId } = req.params;
    console.log('Fetching all reviews for productId:', productId); // Debug log

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({ error: 'productId không hợp lệ' });
    }

    const reviewsCollection = db.collection('reviews');
    const usersCollection = db.collection('users');
    const reviews = await reviewsCollection
      .aggregate([
        { $match: { productId: new ObjectId(productId) } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            userId: 1,
            rating: 1,
            comment: 1,
            createdAt: 1,
            updatedAt: 1,
            userName: '$user.name',
          },
        },
        { $sort: { updatedAt: -1 } },
      ])
      .toArray();

    res.status(200).json(
      reviews.map(review => ({
        userId: review.userId,
        userName: review.userName,
        rating: review.rating || 0,
        comment: review.comment || '',
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
      }))
    );
  } catch (err) {
    console.error('Fetch all reviews error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});






















// Lấy danh sách món ăn yêu thích
// Lấy danh sách món ăn yêu thích hoặc đã đánh giá >= 3 sao
app.get('/api/favourites', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const userId = req.user._id;
    const favouritesCollection = db.collection('favourites');
    const reviewsCollection = db.collection('reviews');
    const menuCollection = db.collection('menu');

    // Lấy các món đã bấm yêu thích
    const favourites = await favouritesCollection
      .aggregate([
        { $match: { userId } },
        {
          $lookup: {
            from: 'menu',
            localField: 'itemId',
            foreignField: '_id',
            as: 'menuItem',
          },
        },
        { $unwind: '$menuItem' },
        {
          $project: {
            itemId: '$itemId',
            name: '$menuItem.name',
            price: '$menuItem.price',
            image: '$menuItem.image',
            rating: '$menuItem.rating',
          },
        },
      ])
      .toArray();

    // Lấy các món user đã đánh giá >= 3 sao
    const reviews = await reviewsCollection
      .find({ userId, rating: { $gte: 3 } })
      .toArray();
    const reviewedMenuIds = reviews.map(r => r.productId);

    // Lấy thông tin món ăn từ menu
    const reviewedMenuItems = await menuCollection
      .find({ _id: { $in: reviewedMenuIds } })
      .toArray();

    // Gộp hai danh sách, tránh trùng lặp
    const allItems = [
      ...favourites,
      ...reviewedMenuItems
        .filter(item => !favourites.some(f => f.itemId?.toString() === item._id.toString()))
        .map(item => ({
          itemId: item._id,
          name: item.name,
          price: item.price,
          image: item.image,
          rating: item.rating,
        })),
    ];

    // Chỉ trả về các món có rating >= 3
    const filtered = allItems.filter(item => (item.rating || 0) >= 3);

    res.status(200).json(filtered);
  } catch (err) {
    console.error('Fetch favourites error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Thêm hoặc xóa món ăn yêu thích
app.post('/api/favourites', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const { itemId, isFavourite } = req.body;
    if (!ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'itemId không hợp lệ' });
    }

    const favouritesCollection = db.collection('favourites');
    const reviewsCollection = db.collection('reviews');
    if (isFavourite) {
      await favouritesCollection.updateOne(
        { userId: req.user._id, itemId: new ObjectId(itemId) },
        {
          $set: {
            userId: req.user._id,
            itemId: new ObjectId(itemId),
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
      res.status(201).json({ message: 'Thêm vào yêu thích thành công' });
    } else {
      // Xoá khỏi favourites
      await favouritesCollection.deleteOne({
        userId: req.user._id,
        itemId: new ObjectId(itemId),
      });
      // Xoá luôn review của user với món này (nếu muốn)
      await reviewsCollection.deleteOne({
        userId: req.user._id,
        productId: new ObjectId(itemId),
      });
      res.status(201).json({ message: 'Xóa khỏi yêu thích và đánh giá thành công' });
    }
  } catch (err) {
    console.error('Toggle favourite error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});













app.put('/auth/update-profile', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
  const { name, age, gender, address, phone } = req.body;
  const token = req.headers.authorization?.split(' ')[1]; // Lấy token từ header

  if (!token) return res.status(401).json({ error: 'Token không hợp lệ' });

  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOneAndUpdate(
      { /* Điều kiện tìm user dựa trên token, ví dụ: email hoặc _id */ }, // Cần thêm logic xác thực token
      { $set: { name, age, gender, address, phone } },
      { returnDocument: 'after' }
    );

    if (!user.value) {
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }

    res.json({
      message: 'Cập nhật thành công',
      user: user.value,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
















/**
 * Slider endpoints using MongoDB (not mongoose)
 * Collection: sliders
 * Image upload: multer (already configured above)
 */

// Create uploads directory if not exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// Middleware for slider admin authentication (reuse authenticateToken, check admin)
const sliderAuth = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ admin mới được thao tác slider' });
  }
  next();
};

// Upload slider image
// ...existing code...
app.post('/api/slider/upload', authenticateToken, sliderAuth, upload.single('file'), (req, res) => {
  try {
    console.log('--- /api/slider/upload called ---');
    console.log('Headers:', req.headers);
    console.log('User on req:', req.user ? { id: req.user._id?.toString?.(), role: req.user.role } : null);
    if (!req.file) {
      console.warn('No file received in upload');
      return res.status(400).json({ error: 'Không có file được upload' });
    }
    console.log('Uploaded file:', req.file);
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    return res.json({ url: imageUrl });
  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: 'Lỗi server khi upload: ' + err.message });
  }
});
// ...existing code...
// Thêm slider mới
app.post('/api/sliders', authenticateToken, sliderAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const { image, title, subtitle } = req.body;
    if (!image || !title || !subtitle) {
      return res.status(400).json({ error: 'Thiếu dữ liệu slider' });
    }
    const slider = {
      image,
      title,
      subtitle,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection('sliders').insertOne(slider);
    res.status(201).json({ ...slider, _id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cập nhật slider
app.put('/api/sliders/:id', authenticateToken, sliderAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const { id } = req.params;
    const { image, title, subtitle } = req.body;
    if (!image || !title || !subtitle) {
      return res.status(400).json({ error: 'Thiếu dữ liệu slider' });
    }
    const result = await db.collection('sliders').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { image, title, subtitle, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result.value) return res.status(404).json({ error: 'Slider không tồn tại' });
    res.json({ ...result.value, _id: result.value._id.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Xóa slider
app.delete('/api/sliders/:id', authenticateToken, sliderAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const { id } = req.params;
    const slider = await db.collection('sliders').findOne({ _id: new ObjectId(id) });
    if (!slider) return res.status(404).json({ error: 'Slider không tồn tại' });
    // Xóa file ảnh nếu có
    if (slider.image && slider.image.startsWith('/uploads/')) {
      const filePath = '.' + slider.image;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await db.collection('sliders').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Xóa slider thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách slider
app.get('/api/sliders', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const sliders = await db.collection('sliders').find().sort({ createdAt: -1 }).toArray();
    res.json(sliders.map(s => ({ ...s, _id: s._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});







const crypto = require("crypto");
const bodyParser = require("body-parser");
app.use(bodyParser.json());
const axios = require("axios");
const { PythonShell } = require('python-shell');
// Config MoMo (Sandbox)
const endpoint = "https://test-payment.momo.vn/gw_payment/transactionProcessor";
const partnerCode = "MOMO";
const accessKey = "F8BBA842ECF85";
const secretKey = "K951B6PE1waDMi640xX08PD3vg6EkVlz";
const requestType = "captureMoMoWallet";

// ⚠️ Dùng domain/ngrok của bạn để MoMo gọi về
const returnUrl = "http://localhost:3000/api/momo/callback";
const notifyUrl = "http://localhost:3000/api/momo/ipn";

// API tạo URL thanh toán MoMo
app.post("/api/momo/create-payment", async (req, res) => {
  const { amount, orderId, orderInfo } = req.body;
  console.log("Request received:", req.body);

  const requestId = Date.now().toString();
  const extraData = "";

  // rawSignature theo format MoMo
  const rawSignature =
    `partnerCode=${partnerCode}&accessKey=${accessKey}&requestId=${requestId}` +
    `&amount=${amount}&orderId=${orderId}&orderInfo=${orderInfo}` +
    `&returnUrl=${returnUrl}&notifyUrl=${notifyUrl}&extraData=${extraData}`;

  // Ký HMAC SHA256
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(rawSignature)
    .digest("hex");

  const requestBody = {
    partnerCode,
    accessKey,
    requestId,
    amount: amount.toString(),
    orderId,
    orderInfo,
    returnUrl,
    notifyUrl,
    extraData,
    requestType,
    signature,
  };

  try {
    const response = await axios.post(endpoint, requestBody, {
      headers: { "Content-Type": "application/json" },
    });

    // response.data.payUrl là đường dẫn thanh toán
    // Tạo QR code từ payUrl bằng cách gọi API QR code
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(response.data.payUrl)}`;

    return res.json({
      payUrl: response.data.payUrl, // URL thanh toán MoMo trả về
      qrCodeUrl: qrCodeUrl, // URL QR code
      requestId: requestId,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "MoMo API error" });
  }
});
app.post("/api/momo/ipn", async (req, res) => {
  console.log("MoMo notify:", req.body);

  const { resultCode, orderId } = req.body;

  if (resultCode === 0) {
    // Cập nhật trạng thái đơn hàng trong MongoDB
    try {
      await Order.findOneAndUpdate(
        { orderId },
        { status: 'completed', updatedAt: new Date() },
        { new: true }
      );
      console.log(`Thanh toán thành công cho orderId=${orderId}`);
    } catch (err) {
      console.error(`Lỗi cập nhật đơn hàng ${orderId}:`, err);
    }
  } else {
    console.log(`Thanh toán thất bại cho orderId=${orderId}`);
  }

  res.status(200).json({ message: "Received IPN from MoMo" });
});











// // Gemini API integration
// require('dotenv').config();

// const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// // Prompt cấu hình cho Gemini chat
// const prompts = {
//   menu: {
//     examples: [
//       "Có những món nào trong thực đơn?",
//       "Đồ uống nào rẻ nhất?",
//       "Bạn có thể gợi ý món phổ biến không?",
//     ],
//     instructions: "Bạn là trợ lý nhà hàng. Sử dụng dữ liệu thực đơn được cung cấp để trả lời các câu hỏi về các món ăn, giá cả và gợi ý. Nếu câu hỏi không liên quan đến thực đơn, trả lời: 'Vui lòng hỏi về thực đơn.'",
//   },
//   orders: {
//     examples: [
//       "Trạng thái đơn hàng của tôi là gì?",
//       "Hiển thị tất cả các đơn hàng đã hoàn thành.",
//       "Có bao nhiêu đơn hàng đang chờ xử lý?",
//     ],
//     instructions: "Bạn là trợ lý theo dõi đơn hàng. Sử dụng dữ liệu đơn hàng được cung cấp để trả lời các câu hỏi về trạng thái, tổng số và số lượng đơn hàng. Nếu câu hỏi không liên quan đến đơn hàng, trả lời: 'Vui lòng hỏi về đơn hàng.'",
//   },
//   inventory: {
//     examples: [
//       "Có bao nhiêu nước trong kho?",
//       "Có đủ nước ép cho 10 đơn hàng không?",
//       "Những món nào trong kho sắp hết?",
//     ],
//     instructions: "Bạn là trợ lý quản lý kho. Sử dụng dữ liệu kho được cung cấp để trả lời các câu hỏi về số lượng tồn kho và tình trạng. Nếu câu hỏi không liên quan đến kho, trả lời: 'Vui lòng hỏi về kho.'",
//   },
//   default: {
//     instructions: "Bạn là trợ lý chung. Trả lời các câu hỏi tốt nhất dựa trên ngữ cảnh được cung cấp, hoặc trả lời 'Tôi không có đủ thông tin để trả lời' nếu không có dữ liệu liên quan.",
//   },
// };

// // Gemini chat endpoint with DB context and prompt instructions
// // ...existing code...
// app.post('/api/chat', async (req, res) => {
//   const { prompt, contextType, productId } = req.body;
//   if (!prompt) {
//     return res.status(400).json({ error: 'Cần nhập câu hỏi' });
//   }
//   if (!db) {
//     return res.status(500).json({ error: 'Chưa kết nối với cơ sở dữ liệu' });
//   }

//   try {
//     let contextText = '';

//     // Nếu yêu cầu context từ menu (sản phẩm)
//     if (contextType === 'menu') {
//       const menuColl = db.collection('menu');

//       if (productId && ObjectId.isValid(productId)) {
//         const p = await menuColl.findOne({ _id: new ObjectId(productId) });
//         if (p) {
//           const imageUrl = p.image
//             ? (p.image.startsWith('http') ? p.image : `${req.protocol}://${req.get('host')}${p.image}`)
//             : '';
//           contextText = `Thông tin sản phẩm:\n- ID: ${p._id}\n- Tên: ${p.name}\n- Giá: ${p.price}\n- Danh mục: ${p.danhmuc}\n- Mô tả: ${p.description ?? ''}\n- Nguyên liệu / topping: ${Array.isArray(p.toppingIds) ? p.toppingIds.join(', ') : (p.toppings ?? '')}\n- Ảnh: ${imageUrl}\n`;
//         } else {
//           contextText = 'Không tìm thấy sản phẩm theo productId được cung cấp.\n';
//         }
//       } else {
//         // Lấy một số sản phẩm (giới hạn để tránh payload quá lớn)
//         const items = await menuColl.find().limit(25).toArray();
//         contextText = 'Danh sách sản phẩm (tóm tắt):\n' +
//           items.map(i => {
//             const img = i.image ? (i.image.startsWith('http') ? i.image : `${req.protocol}://${req.get('host')}${i.image}`) : '';
//             const price = i.price ?? '';
//             const cat = i.danhmuc ?? '';
//             const desc = i.description ?? '';
//             return `- ${i._id}: ${i.name} — ${price} VNĐ — Danh mục: ${cat}${desc ? ' — ' + desc : ''}${img ? ' — ảnh: ' + img : ''}`;
//           }).join('\n');
//       }
//     } else if (contextType === 'orders') {
//       const orders = await db.collection('orders').find().limit(50).toArray();
//       contextText = 'Đơn hàng (tóm tắt):\n' + orders.map(o => `- ${o._id}: trạng thái ${o.status}, tổng ${o.total}`).join('\n');
//     } else if (contextType === 'inventory') {
//       const inventory = await db.collection('inventory').find().limit(50).toArray();
//       contextText = 'Kho (tóm tắt):\n' + inventory.map(i => `- ${i.name}: ${i.quantity} ${i.unit}`).join('\n');
//     }

//     const promptConfig = prompts[contextType] || prompts.default;
//     const fullPrompt = contextText
//       ? `${promptConfig.instructions}\n\n${contextText}\n\nCâu hỏi: ${prompt}`
//       : `${promptConfig.instructions}\n\nCâu hỏi: ${prompt}`;

//     // Gọi Gemini (giữ nguyên logic hiện tại)
//     if (!GEMINI_API_KEY) {
//       return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình trên server' });
//     }

//     const response = await axios.post(
//       GEMINI_API_URL,
//       {
//         contents: [
//           {
//             parts: [
//               { text: fullPrompt }
//             ]
//           }
//         ]
//       },
//       {
//         headers: {
//           'Content-Type': 'application/json',
//           'X-goog-api-key': GEMINI_API_KEY
//         }
//       }
//     );
//     const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
//     res.json({ response: result });
//   } catch (error) {
//     console.error('Lỗi API Gemini hoặc xử lý context:', error.response?.data || error.message);
//     res.status(500).json({ error: 'Không thể tạo nội dung' });
//   }
// });
// Gemini API integration
require('dotenv').config();


const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// *** NÂNG CẤP 1: Thay thế "Prompts" cũ bằng "Persona" và "Templates" ***

// Persona cơ sở cho bot. Bot LÀ AI?
const basePersona = `Bạn là một trợ lý AI hữu ích cho nhà hàng. Bạn có kiến thức chung về mọi chủ đề (như sức khỏe, dinh dưỡng, thời tiết, v.v.).
Bạn CŨNG có quyền truy cập vào dữ liệu nội bộ của nhà hàng (thực đơn, đơn hàng, kho) sẽ được cung cấp bên dưới.

Nhiệm vụ của bạn là:
1.  Trả lời các câu hỏi cụ thể về dữ liệu được cung cấp (ví dụ: 'Món Shu si giá bao nhiêu?').
2.  Trả lời các câu hỏi chung (ví dụ: 'Ăn gì để giảm cân?').
3.  **Quan trọng nhất:** CỐ GẮNG KẾT HỢP cả hai. Nếu một câu hỏi chung (như 'giảm cân') có thể liên quan đến dữ liệu (thực đơn), hãy phân tích dữ liệu và đưa ra gợi ý (ví dụ: 'Để giảm cân, bạn có thể thử món Shu si trong thực đơn của chúng tôi vì nó có tag "healthy" và "giảm cân".').

Hãy luôn thân thiện và hữu ích.
`;

// promptTemplates thay thế cho 'prompts' cũ
const promptTemplates = {
  menu: {
    instructions: "Dưới đây là dữ liệu THỰC ĐƠN. Hãy sử dụng nó để trả lời câu hỏi:",
  },
  orders: {
    instructions: "Dưới đây là dữ liệu ĐƠN HÀNG. Hãy sử dụng nó để trả lời câu hỏi:",
  },
  inventory: {
    instructions: "Dưới đây là dữ liệu KHO. Hãy sử dụng nó để trả lời câu hỏi:",
  },
  default: {
    // Dùng khi không có contextType hoặc contextType không hợp lệ
    instructions: "Không có dữ liệu ngữ cảnh cụ thể nào được cung cấp. Hãy trả lời câu hỏi dựa trên kiến thức chung của bạn.",
  },
};

// ... (code app.listen, db connection...)

// Gemini chat endpoint with DB context and prompt instructions
app.post('/api/chat', async (req, res) => {
  const { prompt, contextType, productId } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Cần nhập câu hỏi' });
  }
  if (!db) {
    return res.status(500).json({ error: 'Chưa kết nối với cơ sở dữ liệu' });
  }

  try {
    let contextText = '';
    // Lấy instruction dựa trên contextType
    const promptConfig = promptTemplates[contextType] || promptTemplates.default;


    // Nếu yêu cầu context từ menu (sản phẩm)
    if (contextType === 'menu') {
      const menuColl = db.collection('menu');

      if (productId && ObjectId.isValid(productId)) {
        const p = await menuColl.findOne({ _id: new ObjectId(productId) });
        if (p) {
          const imageUrl = p.image
            ? (p.image.startsWith('http') ? p.image : `${req.protocol}://${req.get('host')}${p.image}`)
            : '';
          
          // *** NÂNG CẤP 2: Lấy thêm dữ liệu dinh dưỡng cho 1 SẢN PHẨM ***
          contextText = `Thông tin sản phẩm:\n- ID: ${p._id}\n- Tên: ${p.name}\n- Giá: ${p.price} VNĐ\n- Danh mục: ${p.danhmuc}\n- Mô tả: ${p.description ?? ''}\n- Calo: ${p.calories ?? 'N/A'}\n- Protein: ${p.protein ?? 'N/A'} g\n- Fat: ${p.fat ?? 'N/A'} g\n- Tags: ${Array.isArray(p.tags) ? p.tags.join(', ') : 'N/A'}\n- Ảnh: ${imageUrl}\n`;

        } else {
          contextText = 'Không tìm thấy sản phẩm theo productId được cung cấp.\n';
        }
      } else {
        // Lấy một số sản phẩm (giới hạn để tránh payload quá lớn)
        const items = await menuColl.find().limit(25).toArray();
        
        // *** NÂNG CẤP 3: Lấy thêm dữ liệu dinh dưỡng cho DANH SÁCH SẢN PHẨM ***
        contextText = 'Danh sách sản phẩm (tóm tắt):\n' +
          items.map(i => {
            const img = i.image ? (i.image.startsWith('http') ? i.image : `${req.protocol}://${req.get('host')}${i.image}`) : '';
            const price = i.price ?? '';
            const cat = i.danhmuc ?? '';
            
            // Thêm dữ liệu dinh dưỡng nếu có
            const calories = i.calories ? ` - ${i.calories} calo` : '';
            const tags = Array.isArray(i.tags) && i.tags.length > 0 ? ` - Tags: [${i.tags.join(', ')}]` : '';

            return `- ${i.name} — ${price} VNĐ — Danh mục: ${cat}${calories}${tags}`;
          }).join('\n');
      }
    } else if (contextType === 'orders') {
      const orders = await db.collection('orders').find().limit(50).toArray();
      contextText = 'Đơn hàng (tóm tắt):\n' + orders.map(o => `- ${o._id}: trạng thái ${o.status}, tổng ${o.total}`).join('\n');
    } else if (contextType === 'inventory') {
      const inventory = await db.collection('inventory').find().limit(50).toArray();
      contextText = 'Kho (tóm tắt):\n' + inventory.map(i => `- ${i.name}: ${i.quantity} ${i.unit}`).join('\n');
    }

    // *** NÂNG CẤP 4: Xây dựng Full Prompt với Persona ***
    // Luôn bắt đầu bằng basePersona, sau đó là instruction và data (nếu có), cuối cùng là câu hỏi
    const fullPrompt = `${basePersona}\n\n${promptConfig.instructions}\n\n${contextText || '(Không có dữ liệu cho ngữ cảnh này)'}\n\nCâu hỏi của khách hàng: ${prompt}`;

    // Gọi Gemini (giữ nguyên logic gọi API của bạn)
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình trên server' });
    }

    const response = await axios.post(
      GEMINI_API_URL,
      {
        contents: [
          {
            parts: [
              { text: fullPrompt }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_API_KEY
        }
      }
    );
    const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ response: result });
  } catch (error) {
    console.error('Lỗi API Gemini hoặc xử lý context:', error.response?.data || error.message);
    res.status(500).json({ error: 'Không thể tạo nội dung' });
  }
});




// Thêm vào server.js
// Tìm kiếm món ăn
// Tìm kiếm món ăn trong menu theo tên, mô tả, danh mục (case-insensitive, partial match)
// Public search endpoint (no authentication required)
app.get('/api/menu/search', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Thiếu query tìm kiếm ?q=' });

    const menuCollection = db.collection('menu');
    const categoriesCollection = db.collection('categories');

    // Escape regex special characters và tạo regex case-insensitive
    const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQ, 'i');
    
    // Tìm kiếm text trong name, description, danhmuc
    const items = await menuCollection
      .find({
        $or: [
          { name: { $regex: regex } },
          { description: { $regex: regex } },
          { danhmuc: { $regex: regex } },
        ],
      })
      .limit(200)
      .toArray();

    // Map category name -> id và id -> name
    const categories = await categoriesCollection.find().toArray();
    const nameToId = new Map(categories.map(cat => [cat.name, cat._id.toString()]));
    const idToName = new Map(categories.map(cat => [cat._id.toString(), cat.name]));

    // Hàm helper để chuẩn hóa danh mục - xử lý safe hơn
    function normalizeCategory(danhmuc) {
      if (!danhmuc) return '';
      
      // Nếu là string, check xem có phải ObjectId không
      if (typeof danhmuc === 'string') {
        // Nếu là valid ObjectId hex string
        if (/^[0-9a-fA-F]{24}$/.test(danhmuc)) {
          return idToName.get(danhmuc) || danhmuc;
        }
        // Nếu là tên danh mục
        return danhmuc;
      }
      
      // Nếu là ObjectId object
      if (danhmuc && typeof danhmuc === 'object' && danhmuc.toString) {
        const idStr = danhmuc.toString();
        return idToName.get(idStr) || idStr;
      }
      
      return danhmuc.toString();
    }

    // Format dữ liệu trả về
    const formatted = items.map(item => ({
      ...item,
      _id: item._id.toString(),
      danhmuc: normalizeCategory(item.danhmuc),
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    console.error('Search menu error:', err);
    return res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Lấy chi tiết món ăn theo id (đặt sau route tìm kiếm để tránh bị ghi đè bởi '/api/menu/search')
app.get('/api/menu/:id', authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
    }
    const item = await db.collection('menu').findOne({ _id: new ObjectId(id) });
    if (!item) return res.status(404).json({ error: 'Không tìm thấy món ăn' });
    res.status(200).json({ ...item, _id: item._id.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Lấy chi tiết sản phẩm theo id
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // Kiểm tra id hợp lệ
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
    }

    // Tìm sản phẩm
    const product = await db.collection('products').findOne({ _id: new ObjectId(id) });

    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    // Trả về, ép _id thành string
    return res.json({ ...product, _id: product._id.toString() });

  } catch (error) {
    console.error('Get product error:', error);
    return res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }
});





//////////////////////////////////////////////////////////////////////////////
// Tổng doanh thu theo ngày, tuần, tháng
app.get('/api/reports/revenue', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const orders = await db.collection('orders').find({ status: 'completed' }).toArray();

    // Helper để lấy ngày đầu tuần/tháng
    const getStartOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const getStartOfWeek = d => {
      const day = d.getDay() || 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 1);
    };
    const getStartOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);

    let today = getStartOfDay(new Date());
    let week = getStartOfWeek(new Date());
    let month = getStartOfMonth(new Date());

    let revenueToday = 0, revenueWeek = 0, revenueMonth = 0;
    for (const o of orders) {
      const created = new Date(o.createdAt);
      if (created >= today) revenueToday += o.total || 0;
      if (created >= week) revenueWeek += o.total || 0;
      if (created >= month) revenueMonth += o.total || 0;
    }

    res.json({
      today: revenueToday,
      week: revenueWeek,
      month: revenueMonth,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Sản phẩm bán chạy nhất
app.get('/api/reports/best-sellers', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const orders = await db.collection('orders').find({ status: 'completed' }).toArray();
    const menu = await db.collection('menu').find().toArray();

    // Đếm số lượng bán cho từng menuId
    const count = {};
    for (const o of orders) {
      for (const item of o.items || []) {
        count[item.menuId] = (count[item.menuId] || 0) + (item.quantity || 1);
      }
    }
    // Sắp xếp giảm dần
    const sorted = Object.entries(count)
      .sort((a, b) => b[1] - a[1])
      .map(([menuId, qty]) => {
        const m = menu.find(m => m._id.toString() === menuId.toString());
        return {
          menuId,
          name: m?.name || 'Unknown',
          quantity: qty,
          image: m?.image || '',
        };
      });
    res.json(sorted.slice(0, 10)); // Top 10
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Lợi nhuận và chi phí
app.get('/api/reports/profit', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const orders = await db.collection('orders').find({ status: 'completed' }).toArray();
    const menu = await db.collection('menu').find().toArray();

    let totalRevenue = 0, totalCost = 0;
    for (const o of orders) {
      for (const item of o.items || []) {
        const m = menu.find(m => m._id.toString() === item.menuId.toString());
        totalRevenue += (item.price || 0) * (item.quantity || 1);
        totalCost += ((m?.cost || 0) * (item.quantity || 1));
      }
    }
    res.json({
      revenue: totalRevenue,
      cost: totalCost,
      profit: totalRevenue - totalCost,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Báo cáo tồn kho
app.get('/api/reports/inventory', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const inventory = await db.collection('inventory').find().toArray();
    res.json(inventory.map(i => ({
      id: i._id.toString(),
      name: i.name,
      quantity: i.quantity,
      threshold: i.threshold,
      unit: i.unit,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});












// ...existing code...

// --- Staff settings: Lưu và Lấy cài đặt cho staff (GET /api/staff/settings, POST /api/staff/settings) ---
app.get('/api/staff/settings', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    if (!req.user || req.user.role !== 'staff') return res.status(403).json({ error: 'Chỉ staff mới truy cập' });

    const coll = db.collection('staff_settings');
    const settings = await coll.findOne({ userId: req.user._id });
    if (!settings) {
      // trả mặc định nếu chưa có
      return res.status(200).json({ notifications: true, darkMode: false, available: false });
    }
    // gửi về các trường cần thiết
    return res.status(200).json({
      notifications: settings.notifications ?? true,
      darkMode: settings.darkMode ?? false,
      available: settings.available ?? false,
    });
  } catch (err) {
    console.error('Fetch staff settings error:', err);
    return res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

app.post('/api/staff/settings', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    if (!req.user || req.user.role !== 'staff') return res.status(403).json({ error: 'Chỉ staff mới truy cập' });

    const { notifications, darkMode, available } = req.body;
    // basic validation: nếu không gửi các trường thì sẽ giữ giá trị mặc định/hiện có
    const payload = {};
    if (notifications !== undefined) payload.notifications = !!notifications;
    if (darkMode !== undefined) payload.darkMode = !!darkMode;
    if (available !== undefined) payload.available = !!available;

    const coll = db.collection('staff_settings');
    await coll.updateOne(
      { userId: req.user._id },
      { $set: { ...payload, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    // trả về cài đặt hiện tại sau khi lưu
    const saved = await coll.findOne({ userId: req.user._id });
    return res.status(200).json({
      notifications: saved.notifications ?? true,
      darkMode: saved.darkMode ?? false,
      available: saved.available ?? false,
    });
  } catch (err) {
    console.error('Save staff settings error:', err);
    return res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// ...existing code...





























// ...existing code...

// API: Đề xuất món ăn cho người dùng (recommendation)
// ...existing code...
// app.get('/api/recommendation/:userId', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.params.userId;
//     if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

//     const orders = await db.collection('orders').find().toArray();
//     const users = await db.collection('users').find().toArray();
//     const menu = await db.collection('menu').find().toArray();

//     const scriptPath = process.env.RECOMMENDER_SCRIPT_PATH || 'C:\\src\\recomentsystem\\recommendation_model.py';
//     const pythonBin = process.env.PYTHON_BIN || 'python';

//     try {
//       const spawnSync = require('child_process').spawnSync;
//       const payload = JSON.stringify({ orders, users, menu, userId });
//       const maxBuffer = 50 * 1024 * 1024; // 50MB

//       // send JSON via stdin to Python script
//       const result = spawnSync(pythonBin, [scriptPath], { input: payload, maxBuffer, encoding: 'utf8' });

//       if (result.error) throw result.error;
//       if (result.status !== 0) {
//         const errMsg = (result.stderr || '').toString();
//         throw new Error(`Python exited with ${result.status}: ${errMsg}`);
//       }

//       const stdout = (result.stdout || '').toString().trim();
//       if (!stdout) return res.json([]);

//       let recommendations = JSON.parse(stdout);
//       if (!Array.isArray(recommendations)) {
//         if (Array.isArray(recommendations.recommendations)) recommendations = recommendations.recommendations;
//         else return res.json([]);
//       }

//       const formatted = recommendations.map(item => ({
//         _id: item._id?.toString?.() ?? item['_id'] ?? item.id ?? '',
//         name: item.name ?? item.title ?? '',
//         price: Number(item.price || 0),
//         image: item.image ?? item.img ?? '',
//         danhmuc: item.danhmuc ?? item.category ?? '',
//         rating: Number(item.rating || 0),
//       }));

//       return res.json(formatted);
//     } catch (pyErr) {
//       console.error('Python recommender error, falling back to simple recommender:', pyErr);

//       // Fallback simple top-selling recommender
//       const menuMap = new Map(menu.map(m => [m._id.toString(), m]));
//       const counts = {};
//       for (const o of orders) {
//         for (const it of o.items || []) {
//           const mid = (it.menuId && it.menuId.toString) ? it.menuId.toString() : String(it.menuId || '');
//           if (!mid) continue;
//           counts[mid] = (counts[mid] || 0) + (it.quantity || 1);
//         }
//       }
//       const top = Object.entries(counts)
//         .sort((a, b) => b[1] - a[1])
//         .map(([id]) => menuMap.get(id))
//         .filter(Boolean)
//         .slice(0, 5)
//         .map(m => ({
//           _id: m._id.toString(),
//           name: m.name,
//           price: Number(m.price || 0),
//           image: m.image || '',
//           rating: Number(m.rating || 0),
//         }));

//       return res.json(top);
//     }
//   } catch (err) {
//     console.error('Recommendation API error:', err);
//     res.status(500).json({ error: 'Lỗi hệ thống khi lấy gợi ý' });
//   }
// });

// ...
// Tên file giả định: recommendationRoute.js

// ... (các import khác của bạn như express, authenticateToken...)

app.get('/api/recommendation/:userId', authenticateToken, async (req, res) => {
  try {
    const requestedUserId = req.params.userId;
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });

    const rawOrders = await db.collection('orders').find().toArray();
    const rawUsers = await db.collection('users').find().toArray();
    const rawMenu = await db.collection('menu').find().toArray();

    const users = rawUsers.map(u => ({ ...u, _id: u._id.toString() }));
    const menu = rawMenu.map(m => ({ ...m, _id: m._id.toString() }));
    const orders = rawOrders.map(o => ({
      ...o,
      _id: o._id.toString(),
      userId: o.userId ? o.userId.toString() : '',
      items: (o.items || []).map(item => ({
        ...item,
        menuId: item.menuId ? item.menuId.toString() : ''
      }))
    }));

    console.log('--- DEBUG NODE.JS DATA COUNTS ---');
    console.log(`Orders: ${orders.length}, Users: ${users.length}, Menu: ${menu.length}`);
    console.log('---------------------------------');

    const scriptPath = process.env.RECOMMENDER_SCRIPT_PATH || 'C:\\src\\recomentsystem\\recommendation_model.py';
    // DÙNG ĐÚNG PYTHON từ recomentsystem
    const pythonBin = process.env.PYTHON_BIN || 'C:\\src\\recomentsystem\\.venv\\Scripts\\python.exe';

    try {
      const { spawn } = require('child_process');
      const payload = JSON.stringify({ orders, users, menu, userId: requestedUserId });
      const pythonProcess = spawn(pythonBin, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdin.write(payload);
      pythonProcess.stdin.end();

      pythonProcess.stdout.on('data', data => { stdout += data.toString('utf8'); });
      pythonProcess.stderr.on('data', data => { 
        console.error(`[PYTHON_STDERR]: ${data.toString('utf8')}`);
        stderr += data.toString('utf8'); 
      });

      const recommendations = await new Promise((resolve, reject) => {
        pythonProcess.on('close', code => {
          try {
            const trimmedStdout = stdout.trim();
            if (!trimmedStdout) return reject(new Error(`Python output rỗng. Stderr: ${stderr}`));
            let result = JSON.parse(trimmedStdout);
            if (result.error) return reject(new Error(result.error));
            if (!Array.isArray(result)) result = Array.isArray(result.recommendations) ? result.recommendations : [];
            resolve(result);
          } catch (e) {
            console.error('Lỗi parse Python output:', e, 'Raw:', stdout);
            reject(new Error('Lỗi parse Python output'));
          }
        });
        pythonProcess.on('error', err => reject(err));
      });

      const formatted = recommendations.map(item => ({
        _id: item._id?.toString?.() ?? item['_id'] ?? item.id ?? '',
        name: item.name ?? item.title ?? '',
        price: Number(item.price || 0),
        image: item.image ?? item.img ?? '',
        danhmuc: item.danhmuc ?? item.category ?? '',
        rating: Number(item.rating || 0),
        score: item.score || null,
      }));

      return res.json(formatted);

    } catch (pyErr) {
      console.error('Python recommender error, fallback simple recommender:', pyErr.message);

      const menuMap = new Map(menu.map(m => [m._id.toString(), m]));
      const counts = {};
      for (const o of orders) {
        for (const it of o.items || []) {
          const mid = it.menuId;
          if (!mid) continue;
          counts[mid] = (counts[mid] || 0) + (it.quantity || 1);
        }
      }

      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => menuMap.get(id))
        .filter(Boolean)
        .slice(0, 5)
        .map(m => ({
          _id: m._id.toString(),
          name: m.name,
          price: Number(m.price || 0),
          image: m.image || '',
          danhmuc: m.danhmuc || '',
          rating: Number(m.rating || 0),
          score: 0,
          source: 'fallback',
        }));

      return res.json(top);
    }
  } catch (err) {
    console.error('Recommendation API error:', err);
    res.status(500).json({ error: 'Lỗi hệ thống khi lấy gợi ý' });
  }
});

// ...
// ...existing code...






























//admin
// Thống kê dashboard cho admin
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin mới truy cập' });

    const menuCount = await db.collection('menu').countDocuments();
    const orderCount = await db.collection('orders').countDocuments();
    const customerCount = await db.collection('users').countDocuments({ role: 'customer' });

    // Tính tổng doanh thu từ các đơn đã hoàn thành
    const orders = await db.collection('orders').find({ status: 'completed' }).toArray();
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);

    res.json({
      menuCount,
      orderCount,
      customerCount,
      totalRevenue,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// // Doanh thu theo ngày trong tuần hiện tại
// app.get('/api/reports/revenue', authenticateToken, async (req, res) => {
//   try {
//     if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
//     const orders = await db.collection('orders').find({ status: 'completed' }).toArray();

//     // Helper để lấy ngày đầu tuần/tháng
//     const getStartOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
//     const getStartOfWeek = d => {
//       const day = d.getDay() || 7;
//       return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 1);
//     };
//     const getStartOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);

//     let today = getStartOfDay(new Date());
//     let week = getStartOfWeek(new Date());
//     let month = getStartOfMonth(new Date());

//     let revenueToday = 0, revenueWeek = 0, revenueMonth = 0;
//     for (const o of orders) {
//       const created = new Date(o.createdAt);
//       if (created >= today) revenueToday += o.total || 0;
//       if (created >= week) revenueWeek += o.total || 0;
//       if (created >= month) revenueMonth += o.total || 0;
//     }

//     res.json({
//       today: revenueToday,
//       week: revenueWeek,
//       month: revenueMonth,
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
// Doanh thu theo ngày trong tuần hiện tại
app.get('/api/reports/revenue/week', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const orders = await db.collection('orders').find({ status: 'completed' }).toArray();

    // Tính doanh thu từng ngày trong tuần hiện tại
    const now = new Date();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() || 7) + 1);
    const dailyRevenue = Array(7).fill(0); // CN -> T7

    for (const o of orders) {
      const created = new Date(o.createdAt);
      if (created >= startOfWeek) {
        const dayIdx = (created.getDay()) % 7; // 0=CN, 1=T2,...
        dailyRevenue[dayIdx] += o.total || 0;
      }
    }

    res.json({ dailyRevenue }); // [CN, T2, ..., T7]
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//staff
// --- Voucher API ---
app.get('/api/vouchers', authenticateToken, async (req, res) => {
  try {
    const vouchers = await db.collection('vouchers').find().toArray();
    res.status(200).json(vouchers.map(v => ({ ...v, _id: v._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vouchers', authenticateToken, upload.single('image'), async (req, res) => {
  const { code, discount, expiry } = req.body;
  if (!code || !discount || !expiry) {
    return res.status(400).json({ error: 'Thiếu dữ liệu voucher' });
  }
  try {
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    const result = await db.collection('vouchers').insertOne({
      code,
      discount,
      expiry,
      image,
      createdAt: new Date(),
    });
    res.status(201).json({ message: 'Tạo voucher thành công', id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vouchers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('vouchers').deleteOne({ _id: new ObjectId(id) });
    res.status(200).json({ message: 'Xóa voucher thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// --- Combo API ---
app.get('/api/combos', authenticateToken, async (req, res) => {
  try {
    const combos = await db.collection('combos').find().toArray();
    res.status(200).json(combos.map(c => ({ ...c, _id: c._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/combos', authenticateToken, upload.single('image'), async (req, res) => {
  const { name, items, price, description } = req.body;
  if (!name || !items || !price) {
    return res.status(400).json({ error: 'Thiếu dữ liệu combo' });
  }
  try {
    const parsedItems = JSON.parse(items || '[]');
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    const result = await db.collection('combos').insertOne({
      name,
      items: parsedItems, // [{menuId, name, quantity}]
      price,
      description: description || '',
      image,
      createdAt: new Date(),
    });
    res.status(201).json({ message: 'Tạo combo thành công', id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/combos/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('combos').deleteOne({ _id: new ObjectId(id) });
    res.status(200).json({ message: 'Xóa combo thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});






// Lịch sử đơn hàng của nhân viên (đã hoàn thành, đã hủy)
// ...existing code...
app.get('/api/orders/history', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    if (!req.user || req.user.role !== 'staff') return res.status(403).json({ error: 'Chỉ nhân viên mới truy cập' });

    // Lấy tất cả đơn hàng đã hoàn thành hoặc bị hủy (KHÔNG lọc assignedStaffId)
    const orders = await db.collection('orders').find({
      status: { $in: ['completed', 'cancelled'] }
    }).sort({ updatedAt: -1 }).toArray();

    const formatted = orders.map(o => ({
      ...o,
      _id: o._id.toString(),
    }));

    res.status(200).json(formatted);
  } catch (err) {
    console.error('Fetch staff history error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});
// ...existing code...

// Xoá món khỏi giỏ hàng (theo itemId, có thể là menuId hoặc comboId)
app.delete('/api/cart/:itemId', authenticateToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Server chưa kết nối cơ sở dữ liệu' });
    const { itemId } = req.params;
    if (!ObjectId.isValid(itemId)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const cartsCollection = db.collection('carts');
    // Xoá cả comboId và menuId
    await cartsCollection.updateOne(
      { userId: req.user._id },
      { $pull: { items: { $or: [{ menuId: new ObjectId(itemId) }, { comboId: new ObjectId(itemId) }] } } }
    );
    res.status(200).json({ message: 'Xoá sản phẩm khỏi giỏ hàng thành công' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});



//reset pass word
app.post('/auth/reset-password', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Máy chủ hiện chưa sẵn sàng. Vui lòng thử lại sau.' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Vui lòng cung cấp địa chỉ email hợp lệ.' });

  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email });

    if (!user)
      return res.status(404).json({ error: 'Không tìm thấy tài khoản nào khớp với địa chỉ email này.' });

    // Tạo mật khẩu ngẫu nhiên
    const newPassword = Math.random().toString(36).slice(-8);

    // Cập nhật mật khẩu mới
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { password: newPassword } }
    );

    // Cấu hình email transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'phamducnha2003@gmail.com',
        pass: 'ikgf bszh zszs nmpx', // App password Gmail
      },
    });

    // Gửi mail đẹp hơn (HTML + style)
    const mailOptions = {
      from: '"Hệ thống hỗ trợ người dùng" <phamducnha2003@gmail.com>',
      to: email,
      subject: '🔐 Đặt lại mật khẩu tài khoản của bạn',
      html: `
        <div style="font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #007BFF;">Xin chào ${user.name || 'bạn'},</h2>
          <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.</p>
          <p>Dưới đây là mật khẩu mới của bạn:</p>
          <div style="background-color: #f4f4f4; padding: 12px 20px; border-radius: 8px; 
                      display: inline-block; font-size: 18px; letter-spacing: 1px; 
                      margin: 10px 0; color: #000; font-weight: bold;">
            ${newPassword}
          </div>
          <p>👉 Hãy đăng nhập bằng mật khẩu mới và đổi lại mật khẩu để đảm bảo an toàn cho tài khoản.</p>
          <p style="margin-top: 30px; font-size: 14px; color: #777;">
            Trân trọng,<br>
            <strong>Đội ngũ Hỗ trợ Kỹ thuật</strong><br>
            <em>Ứng dụng của bạn</em>
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: '✅ Mật khẩu mới đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư đến (hoặc thư rác).',
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({
      error: '❌ Đã xảy ra lỗi trong quá trình xử lý. Vui lòng thử lại sau.',
      detail: err.message,
    });
  }
});


// const PORT = process.env.PORT || 3000;

// app.listen(3000, '0.0.0.0', () => {
//   console.log('Server chạy ở http://0.0.0.0:3000');
// });
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server đang chạy trên port ${PORT}`);
});