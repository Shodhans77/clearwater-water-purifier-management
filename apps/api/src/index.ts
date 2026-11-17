import './env.js';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { PrismaClient, Severity, DeviceKind, Role } from '@prisma/client';
import { z } from 'zod';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const app = express();
const db = new PrismaClient();
const port = Number(process.env.PORT || 4000);
const secret = process.env.JWT_SECRET || 'dev-only-change-me';

// Allow BigInt values from PostgreSQL to be safely converted to JSON strings.
const jsonSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

// Apply the conversion globally to every Express res.json() response.
app.set('json replacer', jsonSafe);

// Support both the current Vite port and the previous default port.
const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:5174';

app.use(cors({
  origin: [
    webOrigin,
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174'
  ]
}));

app.use(express.json({ limit: '32kb' }));

const clients = new Set<{ userId: string; res: express.Response }>();

const auth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    (req as any).user = jwt.verify(
      (req.headers.authorization || '').replace(/^Bearer /, ''),
      secret
    );
    next();
  } catch {
    return res.status(401).json({ error: 'Sign in required' });
  }
};

const staff = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (!['PROVIDER', 'ADMIN'].includes((req as any).user?.role)) {
    return res.status(403).json({ error: 'Provider access required' });
  }
  next();
};

const hash = (s: string) =>
  createHash('sha256').update(s).digest('hex');

const secretMatches = (candidate: string, stored: string) => {
  const a = Buffer.from(hash(candidate), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const canAccessDevice = async (user: any, d: any) => {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'CUSTOMER') return d.customerId === user.id;

  return !!(
    d.organizationId &&
    await db.membership.findFirst({
      where: {
        userId: user.id,
        organizationId: d.organizationId
      }
    })
  );
};

// Live event broadcasting, with BigInt-safe serialization.
const publish = async (deviceOrEvent: any, payload?: unknown) => {
  const deviceId =
    typeof deviceOrEvent === 'string'
      ? deviceOrEvent
      : deviceOrEvent?.deviceId;

  if (!deviceId) return;

  const message = payload ?? deviceOrEvent;

  const d = await db.device.findUnique({
    where: { deviceId },
    select: {
      id: true,
      deviceId: true,
      customerId: true,
      organizationId: true
    }
  });

  if (!d) return;

  for (const c of clients) {
    const user = await db.user.findUnique({
      where: { id: c.userId },
      select: { id: true, role: true }
    });

    if (user && await canAccessDevice(user, d)) {
      c.res.write(
        `data: ${JSON.stringify(message, jsonSafe)}\n\n`
      );
    }
  }
};

app.get('/api/health', (_, res) =>
  res.json({ ok: true, service: 'ClearWater API' })
);

// AUTHENTICATION

app.post('/api/auth/register', async (req, res) => {
  const p = z.object({
    email: z.string().email(),
    username: z.string().min(2),
    password: z.string().min(10),
    role: z.enum(['CUSTOMER', 'PROVIDER'])
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  try {
    const u = await db.user.create({
      data: {
        email: p.data.email.toLowerCase(),
        username: p.data.username,
        passwordHash: await bcrypt.hash(p.data.password, 12),
        role: p.data.role
      }
    });

    if (u.role === 'PROVIDER') {
      await db.organization.create({
        data: {
          name: `${u.username}'s Service Organization`,
          members: { create: { userId: u.id } }
        }
      });
    }

    res.status(201).json({
      token: jwt.sign(
        { id: u.id, role: u.role, email: u.email },
        secret,
        { expiresIn: '12h' }
      ),
      user: {
        email: u.email,
        username: u.username,
        role: u.role
      }
    });
  } catch {
    res.status(409).json({
      error: 'Email or username already registered'
    });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const p = z.object({
    email: z.string().email()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({
      error: 'Enter a valid email address.'
    });
  }

  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASSWORD ||
    !process.env.SMTP_FROM
  ) {
    return res.status(503).json({
      error: 'Password reset email is not configured. No email was sent.'
    });
  }

  const user = await db.user.findUnique({
    where: { email: p.data.email.toLowerCase() }
  });

  if (user) {
    const token = randomBytes(32).toString('base64url');

    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD
        }
      });

      const link =
        `${webOrigin}/?reset=${encodeURIComponent(token)}`;

      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: user.email,
        subject: 'Reset your ClearWater password',
        text: `Reset your password within 30 minutes: ${link}`
      });
    } catch (e) {
      await db.passwordResetToken.updateMany({
        where: {
          tokenHash: hash(token),
          usedAt: null
        },
        data: { usedAt: new Date() }
      });

      console.error('SMTP reset delivery failed', e);

      return res.status(503).json({
        error: 'Password reset email could not be delivered. Check SMTP settings; no email was sent.'
      });
    }
  }

  res.json({
    message: 'If the account exists, a reset link will be sent.'
  });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const p = z.object({
    token: z.string().min(20),
    password: z.string().min(10)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const record = await db.passwordResetToken.findFirst({
    where: {
      tokenHash: hash(p.data.token),
      usedAt: null,
      expiresAt: { gt: new Date() }
    }
  });

  if (!record) {
    return res.status(400).json({
      error: 'Reset link is invalid or expired.'
    });
  }

  const now = new Date();

  await db.$transaction([
    db.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await bcrypt.hash(p.data.password, 12)
      }
    }),
    db.passwordResetToken.updateMany({
      where: {
        userId: record.userId,
        usedAt: null
      },
      data: { usedAt: now }
    })
  ]);

  res.json({ reset: true });
});

app.post('/api/auth/login', async (req, res) => {
  const u = await db.user.findUnique({
    where: {
      email: String(req.body.email || '').toLowerCase()
    }
  });

  if (
    !u ||
    !await bcrypt.compare(
      String(req.body.password || ''),
      u.passwordHash
    )
  ) {
    return res.status(401).json({
      error: 'Invalid email or password'
    });
  }

  res.json({
    token: jwt.sign(
      { id: u.id, role: u.role, email: u.email },
      secret,
      { expiresIn: '12h' }
    ),
    user: {
      email: u.email,
      username: u.username,
      role: u.role
    }
  });
});

app.get('/api/me', auth, async (req, res) => {
  res.json(await db.user.findUnique({
    where: { id: (req as any).user.id },
    select: {
      id: true,
      email: true,
      username: true,
      role: true
    }
  }));
});

// DEVICES

app.get('/api/devices', auth, async (req, res) => {
  const u = (req as any).user;

  const where: any = u.role === 'CUSTOMER'
    ? { customerId: u.id }
    : { organization: { members: { some: { userId: u.id } } } };

  res.json(await db.device.findMany({
    where,
    include: {
      building: true,
      floor: true,
      telemetry: {
        orderBy: { receivedAt: 'desc' },
        take: 1
      },
      alerts: {
        where: { resolvedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 4
      }
    }
  }));
});

app.post('/api/devices', auth, staff, async (req, res) => {
  const p = z.object({
    deviceId: z.string().min(3),
    name: z.string().min(2),
    buildingId: z.string().optional(),
    floorId: z.string().optional(),
    customerId: z.string().optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  if (
    p.data.buildingId &&
    !await db.building.findFirst({
      where: {
        id: p.data.buildingId,
        organizationId: m.organizationId
      }
    })
  ) {
    return res.status(400).json({
      error: 'Building is not in your organization'
    });
  }

  if (
    p.data.floorId &&
    !await db.floor.findFirst({
      where: {
        id: p.data.floorId,
        building: {
          organizationId: m.organizationId,
          ...(p.data.buildingId ? { id: p.data.buildingId } : {})
        }
      }
    })
  ) {
    return res.status(400).json({
      error: 'Floor is not in the selected organization/building'
    });
  }

  if (
    p.data.customerId &&
    !await db.user.findFirst({
      where: {
        id: p.data.customerId,
        role: Role.CUSTOMER
      }
    })
  ) {
    return res.status(400).json({
      error: 'Customer account not found'
    });
  }

  const deviceSecret = randomBytes(32).toString('base64url');

  const existing = await db.device.findUnique({
    where: { deviceId: p.data.deviceId }
  });

  if (existing) {
    if (
      existing.kind !== DeviceKind.REAL ||
      existing.organizationId !== m.organizationId
    ) {
      return res.status(409).json({
        error: 'Device ID already exists outside your organization'
      });
    }

    const updated = await db.device.update({
      where: { id: existing.id },
      data: {
        secretHash: hash(deviceSecret),
        name: p.data.name,
        buildingId: p.data.buildingId,
        floorId: p.data.floorId
      }
    });

    return res.json({
      device: updated,
      deviceSecret,
      secretShownOnce: true,
      rotated: true
    });
  }

  try {
    const device = await db.device.create({
      data: {
        ...p.data,
        kind: DeviceKind.REAL,
        organizationId: m.organizationId,
        secretHash: hash(deviceSecret)
      }
    });

    res.status(201).json({
      device,
      deviceSecret,
      secretShownOnce: true
    });
  } catch {
    res.status(409).json({
      error: 'Device ID already exists'
    });
  }
});

app.post('/api/devices/:deviceId/rotate-secret', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  const device = await db.device.findFirst({
    where: {
      deviceId: String(req.params.deviceId),
      organizationId: m.organizationId,
      kind: DeviceKind.REAL
    }
  });

  if (!device) return res.sendStatus(404);

  const deviceSecret = randomBytes(32).toString('base64url');

  await db.device.update({
    where: { id: device.id },
    data: {
      secretHash: hash(deviceSecret),
      lastSeen: null
    }
  });

  res.json({
    deviceId: device.deviceId,
    deviceSecret,
    secretShownOnce: true
  });
});

app.post('/api/demo/reset', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  const ds = await db.device.findMany({
    where: {
      organizationId: m.organizationId,
      kind: DeviceKind.DEMO
    },
    select: { id: true }
  });

  const ids = ds.map(x => x.id);

  await db.$transaction([
    db.telemetry.deleteMany({
      where: { deviceId: { in: ids } }
    }),
    db.alert.deleteMany({
      where: { deviceId: { in: ids } }
    }),
    db.device.updateMany({
      where: { id: { in: ids } },
      data: { lastSeen: null }
    })
  ]);

  res.json({ resetDevices: ids.length });
});

// TELEMETRY CALIBRATION

app.use('/api/telemetry', async (req, res, next) => {
  try {
    if (req.method !== 'POST') return next();

    const deviceId = String(req.header('x-device-id') || '');
    const d = await db.device.findUnique({
      where: { deviceId }
    });

    if (!d) return next();

    const c = (await db.calibration.findUnique({
      where: { deviceId: d.id }
    })) || {
      tdsSlope: null,
      tdsOffset: null,
      phSlope: null,
      phOffset: null,
      turbiditySlope: null,
      turbidityOffset: null,
      pulsesPerLitre: 450
    };

    const body = req.body as any;

    if (
      body.rawTds !== undefined &&
      c.tdsSlope !== null &&
      c.tdsSlope !== undefined &&
      c.tdsOffset !== null &&
      c.tdsOffset !== undefined
    ) {
      body.tdsPpm = Number(
        (body.rawTds * c.tdsSlope + c.tdsOffset).toFixed(2)
      );
    }

    if (
      body.rawPh !== undefined &&
      c.phSlope !== null &&
      c.phSlope !== undefined &&
      c.phOffset !== null &&
      c.phOffset !== undefined
    ) {
      body.ph = Number(
        (body.rawPh * c.phSlope + c.phOffset).toFixed(2)
      );
    }

    if (
      body.rawTurbidity !== undefined &&
      c.turbiditySlope !== null &&
      c.turbiditySlope !== undefined &&
      c.turbidityOffset !== null &&
      c.turbidityOffset !== undefined
    ) {
      body.turbidityNtu = Number(
        (body.rawTurbidity * c.turbiditySlope + c.turbidityOffset).toFixed(2)
      );
    }

    if (body.pulseCount !== undefined) {
      body.flowLpm = Number(
        (body.pulseCount * 6 / c.pulsesPerLitre).toFixed(3)
      );

      const previous = await db.telemetry.findFirst({
        where: { deviceId: d.id },
        orderBy: { receivedAt: 'desc' }
      });

      body.cumulativeLitres = Number(
        Math.max(
          (previous?.cumulativeLitres || 0) +
            body.pulseCount / c.pulsesPerLitre,
          body.cumulativeLitres || 0
        ).toFixed(3)
      );
    }

    next();
  } catch (e) {
    next(e);
  }
});

app.post('/api/telemetry', async (req, res) => {
  const deviceId = String(req.header('x-device-id') || '');
  const credential = String(req.header('x-device-secret') || '');

  if (!deviceId || !credential) return res.sendStatus(401);

  const d = await db.device.findUnique({
    where: { deviceId }
  });

  if (
    !d ||
    d.kind !== 'REAL' ||
    !d.secretHash ||
    !secretMatches(credential, d.secretHash)
  ) {
    return res.status(401).json({
      error: 'Invalid device credentials'
    });
  }

  const p = z.object({
    timestamp: z.string().datetime().optional(),
    sequence: z.number().int().nonnegative().optional(),
    rawTds: z.number().int().optional(),
    rawPh: z.number().int().optional(),
    rawTurbidity: z.number().int().optional(),
    pulseCount: z.number().int().nonnegative().optional(),
    flowLpm: z.number().nonnegative().optional(),
    cumulativeLitres: z.number().nonnegative().optional(),
    leakage: z.boolean(),
    temperatureC: z.number().optional(),
    humidityPct: z.number().optional(),
    sensorHealth: z.record(z.boolean()).optional(),
    tdsPpm: z.number().nonnegative().optional(),
    ph: z.number().min(0).max(14).optional(),
    turbidityNtu: z.number().nonnegative().optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  try {
    const v = p.data;

    const t = await db.telemetry.create({
      data: {
        deviceId: d.id,
        deviceTimestamp: v.timestamp ? new Date(v.timestamp) : undefined,
        sequence: v.sequence === undefined ? undefined : BigInt(v.sequence),
        rawTds: v.rawTds,
        rawPh: v.rawPh,
        rawTurbidity: v.rawTurbidity,
        pulseCount: v.pulseCount,
        flowLpm: v.flowLpm,
        cumulativeLitres: v.cumulativeLitres,
        leakage: v.leakage,
        temperatureC: v.temperatureC,
        humidityPct: v.humidityPct,
        sensorHealth: v.sensorHealth,
        tdsPpm: v.tdsPpm,
        ph: v.ph,
        turbidityNtu: v.turbidityNtu
      }
    });

    await db.device.update({
      where: { id: d.id },
      data: { lastSeen: new Date() }
    });

    await evaluate(d.id, v);

    await publish(deviceId, {
      deviceId,
      telemetry: {
        ...t,
        sequence: t.sequence?.toString()
      }
    });

    res.status(202).json({ accepted: true });
  } catch {
    res.status(409).json({
      error: 'Duplicate sequence or storage conflict'
    });
  }
});

// WATER QUALITY ALERT EVALUATION

async function evaluate(deviceId: string, v: any) {
  const c = await db.calibration.findUnique({
    where: { deviceId }
  });

  const checks: any[] = [];

  if (v.leakage) {
    checks.push([
      'LEAK',
      'Leakage detected',
      Severity.RED,
      'Leak sensor active',
      'No leakage',
      'Inspect and close the water supply.'
    ]);
  }

  if (v.tdsPpm !== undefined && v.tdsPpm > (c?.tdsWarning ?? 500)) {
    checks.push([
      'TDS_HIGH',
      'TDS above configured limit',
      Severity.YELLOW,
      String(v.tdsPpm),
      `<= ${c?.tdsWarning ?? 500} ppm`,
      'Check source water and calibration.'
    ]);
  }

  if (
    v.ph !== undefined &&
    (v.ph < (c?.phLowWarning ?? 6.5) ||
      v.ph > (c?.phHighWarning ?? 8.5))
  ) {
    checks.push([
      'PH_RANGE',
      'pH outside configured range',
      Severity.YELLOW,
      String(v.ph),
      `${c?.phLowWarning ?? 6.5}–${c?.phHighWarning ?? 8.5}`,
      'Verify calibration and treatment.'
    ]);
  }

  if (v.turbidityNtu !== undefined) {
    // Use calibrated NTU when calibration is available.
    if (v.turbidityNtu > (c?.turbidityWarning ?? 5)) {
      checks.push([
        'TURBIDITY',
        'High turbidity',
        Severity.YELLOW,
        String(v.turbidityNtu),
        `<= ${c?.turbidityWarning ?? 5} NTU`,
        'Inspect filter and source water.'
      ]);
    }
  } else if (v.rawTurbidity !== undefined && v.rawTurbidity <= 1500) {
    // Provisional demo-only rule for this TS-300B setup; this is ADC, not NTU.
    checks.push([
      'TURBIDITY_RAW_ADC',
      'Turbidity warning (raw ADC)',
      Severity.YELLOW,
      String(v.rawTurbidity),
      '> 1500 ADC for normal indication',
      'Demo threshold only. Calibrate with turbidity standards before real-world use.'
    ]);
  }

  for (const [sensor, ok] of Object.entries(v.sensorHealth || {})) {
    if (ok === false) {
      checks.push([
        `SENSOR_${String(sensor).toUpperCase()}`,
        `${sensor} sensor disconnected`,
        Severity.RED,
        'Sensor health false',
        'Sensor connected',
        'Inspect sensor wiring and power.'
      ]);
    }
  }

  const active = new Set(checks.map(x => x[0]));

  await db.alert.updateMany({
    where: {
      deviceId,
      resolvedAt: null,
      code: { notIn: [...active] }
    },
    data: { resolvedAt: new Date() }
  });

  for (const [
    code,
    title,
    severity,
    value,
    expected,
    recommendation
  ] of checks) {
    if (
      !await db.alert.findFirst({
        where: { deviceId, code, resolvedAt: null }
      })
    ) {
      const alert = await db.alert.create({
        data: {
          deviceId,
          code,
          title,
          severity,
          value,
          expected,
          recommendation
        }
      });

      const d = await db.device.findUnique({
        where: { id: deviceId },
        select: { deviceId: true }
      });

      if (d) {
        await publish(d.deviceId, {
          deviceId: d.deviceId,
          alert
        });
      }
    }
  }
}

// LIVE EVENTS

app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  res.write('event: ready\ndata: {}\n\n');

  const c = {
    userId: (req as any).user.id,
    res
  };

  clients.add(c);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(c);
  });
});

// ALERTS

app.get('/api/alerts', auth, async (req, res) => {
  const u = (req as any).user;

  res.json(await db.alert.findMany({
    where: {
      resolvedAt: null,
      device: u.role === 'CUSTOMER'
        ? { customerId: u.id }
        : {
            organization: {
              members: { some: { userId: u.id } }
            }
          }
    },
    include: { device: true },
    orderBy: { createdAt: 'desc' }
  }));
});

app.patch('/api/alerts/:id', auth, async (req, res) => {
  const a: any = await db.alert.findUnique({
    where: { id: String(req.params.id) },
    include: { device: true }
  });

  if (!a) return res.sendStatus(404);

  if (!await canAccessDevice((req as any).user, a.device)) {
    return res.sendStatus(403);
  }

  const x = await db.alert.update({
    where: { id: a.id },
    data: req.body.resolve
      ? { resolvedAt: new Date() }
      : { acknowledgedAt: new Date() }
  });

  publish({ alert: x });

  res.json(x);
});

// ACCOUNT SECURITY

app.post('/api/security/password', auth, async (req, res) => {
  const p = z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(10)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const u = await db.user.findUnique({
    where: { id: (req as any).user.id }
  });

  if (
    !u ||
    !await bcrypt.compare(p.data.currentPassword, u.passwordHash)
  ) {
    return res.status(400).json({
      error: 'Current password is incorrect'
    });
  }

  await db.user.update({
    where: { id: u.id },
    data: {
      passwordHash: await bcrypt.hash(p.data.newPassword, 12)
    }
  });

  res.json({ updated: true });
});

app.post('/api/security/username', auth, async (req, res) => {
  const p = z.object({
    username: z.string().min(2)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  try {
    res.json(await db.user.update({
      where: { id: (req as any).user.id },
      data: { username: p.data.username },
      select: { username: true }
    }));
  } catch {
    res.status(409).json({
      error: 'Username already in use'
    });
  }
});

app.post('/api/security/email', auth, async (req, res) => {
  const p = z.object({
    email: z.string().email()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  try {
    res.json(await db.user.update({
      where: { id: (req as any).user.id },
      data: { email: p.data.email.toLowerCase() },
      select: { email: true }
    }));
  } catch {
    res.status(409).json({
      error: 'Email already in use'
    });
  }
});

// BUILDINGS

app.get('/api/buildings', auth, staff, async (req, res) => {
  const u = (req as any).user;

  res.json(await db.building.findMany({
    where: {
      organization: {
        members: { some: { userId: u.id } }
      }
    },
    include: {
      floors: {
        include: {
          devices: {
            include: {
              telemetry: {
                orderBy: { receivedAt: 'desc' },
                take: 1
              }
            }
          }
        }
      }
    }
  }));
});

app.post('/api/buildings', auth, staff, async (req, res) => {
  const p = z.object({
    name: z.string().min(2),
    address: z.string().min(3)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  res.status(201).json(await db.building.create({
    data: {
      ...p.data,
      organizationId: m.organizationId
    }
  }));
});

app.patch('/api/buildings/:id', auth, staff, async (req, res) => {
  const u = (req as any).user;
  const m = await db.membership.findFirst({
    where: { userId: u.id }
  });
  const id = String(req.params.id);

  if (!m) return res.sendStatus(403);

  const exists = await db.building.findFirst({
    where: {
      id,
      organizationId: m.organizationId
    }
  });

  if (!exists) return res.sendStatus(404);

  const p = z.object({
    name: z.string().min(2).optional(),
    address: z.string().min(3).optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.json(await db.building.update({
    where: { id },
    data: p.data
  }));
});

app.delete('/api/buildings/:id', auth, staff, async (req, res) => {
  const u = (req as any).user;
  const m = await db.membership.findFirst({
    where: { userId: u.id }
  });
  const id = String(req.params.id);

  if (!m) return res.sendStatus(403);

  const b = await db.building.findFirst({
    where: {
      id,
      organizationId: m.organizationId
    },
    include: { devices: true }
  });

  if (!b) return res.sendStatus(404);

  if (b.devices.length) {
    return res.status(409).json({
      error: 'Move or remove devices before deleting this building'
    });
  }

  await db.building.delete({ where: { id } });

  res.sendStatus(204);
});

app.post('/api/buildings/:id/floors', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (
    !m ||
    !await db.building.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: m.organizationId
      }
    })
  ) {
    return res.sendStatus(404);
  }

  const p = z.object({
    label: z.string().min(1)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  try {
    res.status(201).json(await db.floor.create({
      data: {
        label: p.data.label,
        buildingId: String(req.params.id)
      }
    }));
  } catch {
    res.status(409).json({
      error: 'Floor already exists'
    });
  }
});

// DEVICE HISTORY

app.get('/api/devices/:deviceId/history', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  const from = new Date(
    Date.now() - Math.min(Number(req.query.days) || 1, 90) * 864e5
  );

  res.json(await db.telemetry.findMany({
    where: {
      deviceId: d.id,
      receivedAt: { gte: from }
    },
    orderBy: { receivedAt: 'asc' },
    take: 10000
  }));
});

app.get('/api/devices/:deviceId/calibration', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  res.json(await db.calibration.findUnique({
    where: { deviceId: d.id }
  }));
});

app.put('/api/devices/:deviceId/calibration', auth, staff, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  const p = z.object({
    tdsSlope: z.number().optional(),
    tdsOffset: z.number().optional(),
    phSlope: z.number().optional(),
    phOffset: z.number().optional(),
    turbiditySlope: z.number().optional(),
    turbidityOffset: z.number().optional(),
    pulsesPerLitre: z.number().positive().optional(),
    tdsWarning: z.number().positive().optional(),
    phLowWarning: z.number().min(0).max(14).optional(),
    phHighWarning: z.number().min(0).max(14).optional(),
    turbidityWarning: z.number().positive().optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.json(await db.calibration.upsert({
    where: { deviceId: d.id },
    create: { deviceId: d.id, ...p.data },
    update: p.data
  }));
});

app.get('/api/devices/:deviceId/quality', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  const c = await db.calibration.findUnique({
    where: { deviceId: d.id }
  });

  const t = await db.telemetry.findFirst({
    where: { deviceId: d.id },
    orderBy: { receivedAt: 'desc' }
  });

  const calibrated = !!(
    c?.tdsSlope !== null &&
    c?.tdsSlope !== undefined &&
    c?.tdsOffset !== null &&
    c?.tdsOffset !== undefined &&
    c?.phSlope !== null &&
    c?.phSlope !== undefined &&
    c?.phOffset !== null &&
    c?.phOffset !== undefined &&
    c?.turbiditySlope !== null &&
    c?.turbiditySlope !== undefined &&
    c?.turbidityOffset !== null &&
    c?.turbidityOffset !== undefined
  );

  if (
    !calibrated ||
    t?.tdsPpm == null ||
    t.ph == null ||
    t.turbidityNtu == null
  ) {
    return res.json({
      score: null,
      classification: 'Calibration needed',
      calibrated: false
    });
  }

  const a = Math.max(
    0,
    100 * (1 - t.tdsPpm / (2 * (c!.tdsWarning || 500)))
  );

  const b = Math.max(0, 100 - Math.abs(t.ph - 7) * 20);

  const e = Math.max(
    0,
    100 * (1 - t.turbidityNtu / (2 * (c!.turbidityWarning || 5)))
  );

  const score = Math.round((a + b + e) / 3);

  res.json({
    score,
    classification:
      score >= 80
        ? 'Within configured bands'
        : score >= 55
          ? 'Attention recommended'
          : 'Outside configured bands',
    calibrated: true,
    informational: true,
    disclaimer:
      'This score is a monitoring indicator and does not certify water as safe to drink.'
  });
});

// MAINTENANCE

app.get('/api/devices/:deviceId/maintenance', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  res.json(await db.maintenance.findMany({
    where: { deviceId: d.id },
    orderBy: { createdAt: 'desc' }
  }));
});

app.post('/api/devices/:deviceId/maintenance', auth, staff, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  const p = z.object({
    action: z.string().min(2),
    notes: z.string().optional(),
    filterInstalledAt: z.string().datetime().optional(),
    estimatedDue: z.string().datetime().optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.status(201).json(await db.maintenance.create({
    data: {
      deviceId: d.id,
      action: p.data.action,
      notes: p.data.notes,
      filterInstalledAt: p.data.filterInstalledAt
        ? new Date(p.data.filterInstalledAt)
        : undefined,
      estimatedDue: p.data.estimatedDue
        ? new Date(p.data.estimatedDue)
        : undefined
    }
  }));
});

// SERVICE REQUESTS

app.get('/api/service-requests', auth, async (req, res) => {
  const u = (req as any).user;

  const where: any = u.role === 'CUSTOMER'
    ? { customerId: u.id }
    : {
        device: {
          organization: {
            members: { some: { userId: u.id } }
          }
        }
      };

  res.json(await db.serviceRequest.findMany({
    where,
    include: {
      device: {
        select: { deviceId: true, name: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  }));
});

app.post('/api/service-requests', auth, async (req, res) => {
  const u = (req as any).user;

  if (u.role !== 'CUSTOMER') return res.sendStatus(403);

  const p = z.object({
    deviceId: z.string(),
    description: z.string().min(5)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const d = await db.device.findFirst({
    where: {
      deviceId: p.data.deviceId,
      customerId: u.id
    }
  });

  if (!d) return res.sendStatus(404);

  res.status(201).json(await db.serviceRequest.create({
    data: {
      deviceId: d.id,
      customerId: u.id,
      description: p.data.description
    }
  }));
});

app.patch('/api/service-requests/:id', auth, staff, async (req, res) => {
  const u = (req as any).user;

  const m = await db.membership.findFirst({
    where: { userId: u.id }
  });

  const r = await db.serviceRequest.findUnique({
    where: { id: String(req.params.id) }
  });

  if (!m || !r) return res.sendStatus(404);

  const d = await db.device.findFirst({
    where: {
      id: r.deviceId,
      organizationId: m.organizationId
    }
  });

  if (!d) return res.sendStatus(404);

  const p = z.object({
    status: z.enum([
      'OPEN',
      'SCHEDULED',
      'IN_PROGRESS',
      'RESOLVED',
      'CANCELLED'
    ])
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.json(await db.serviceRequest.update({
    where: { id: r.id },
    data: { status: p.data.status }
  }));
});

// TECHNICIANS

app.get('/api/technicians', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  res.json(await db.technician.findMany({
    where: { organizationId: m.organizationId },
    orderBy: { name: 'asc' }
  }));
});

app.post('/api/technicians', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  const p = z.object({
    name: z.string().min(2),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    specialties: z.array(z.string()).default([])
  }).safeParse(req.body);

  if (!m) return res.sendStatus(403);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.status(201).json(await db.technician.create({
    data: {
      ...p.data,
      organizationId: m.organizationId
    }
  }));
});

app.patch('/api/technicians/:id', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  const id = String(req.params.id);

  if (!m) return res.sendStatus(403);

  const t = await db.technician.findFirst({
    where: {
      id,
      organizationId: m.organizationId
    }
  });

  if (!t) return res.sendStatus(404);

  const p = z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
    specialties: z.array(z.string()).optional(),
    active: z.boolean().optional()
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  res.json(await db.technician.update({
    where: { id },
    data: p.data
  }));
});

// BILLING

app.get('/api/billing', auth, async (req, res) => {
  const u = (req as any).user;

  const where: any = u.role === 'CUSTOMER'
    ? { customerId: u.id }
    : {
        organization: {
          members: { some: { userId: u.id } }
        }
      };

  res.json(await db.billingRecord.findMany({
    where,
    include: {
      device: {
        select: { deviceId: true, name: true }
      }
    },
    orderBy: { periodStart: 'desc' }
  }));
});

app.post('/api/billing', auth, staff, async (req, res) => {
  const u = (req as any).user;

  const m = await db.membership.findFirst({
    where: { userId: u.id }
  });

  const p = z.object({
    deviceId: z.string(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    amount: z.number().nonnegative(),
    currency: z.string().length(3).default('INR'),
    status: z.enum(['DRAFT', 'OPEN', 'PAID', 'VOID']).default('DRAFT')
  }).safeParse(req.body);

  if (!m) return res.sendStatus(403);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const d = await db.device.findFirst({
    where: {
      deviceId: p.data.deviceId,
      organizationId: m.organizationId
    }
  });

  if (!d) return res.sendStatus(404);

  res.status(201).json(await db.billingRecord.create({
    data: {
      organizationId: m.organizationId,
      deviceId: d.id,
      customerId: d.customerId,
      periodStart: new Date(p.data.periodStart),
      periodEnd: new Date(p.data.periodEnd),
      amount: p.data.amount,
      currency: p.data.currency,
      status: p.data.status
    }
  }));
});

// CUSTOMER DEVICE CLAIMING

app.get('/api/devices/:deviceId/claim-code', auth, staff, async (req, res) => {
  const m = await db.membership.findFirst({
    where: { userId: (req as any).user.id }
  });

  if (!m) return res.sendStatus(403);

  const d = await db.device.findFirst({
    where: {
      deviceId: String(req.params.deviceId),
      organizationId: m.organizationId,
      kind: DeviceKind.REAL
    }
  });

  if (!d) return res.sendStatus(404);

  if (d.customerId) {
    return res.status(409).json({
      error: 'This purifier is already assigned to a customer.'
    });
  }

  const claimCode = randomBytes(8).toString('hex').toUpperCase();

  await db.device.update({
    where: { id: d.id },
    data: { claimCodeHash: hash(claimCode) }
  });

  res.json({
    deviceId: d.deviceId,
    claimCode,
    shownOnce: true
  });
});

app.post('/api/customer/claim', auth, async (req, res) => {
  const u = (req as any).user;

  if (u.role !== 'CUSTOMER') return res.sendStatus(403);

  const p = z.object({
    deviceId: z.string(),
    claimCode: z.string().min(8)
  }).safeParse(req.body);

  if (!p.success) {
    return res.status(400).json({ error: p.error.flatten() });
  }

  const d = await db.device.findUnique({
    where: { deviceId: p.data.deviceId }
  });

  if (
    !d ||
    d.kind !== 'REAL' ||
    d.customerId ||
    !d.claimCodeHash ||
    !secretMatches(p.data.claimCode.toUpperCase(), d.claimCodeHash)
  ) {
    return res.status(400).json({
      error: 'Invalid claim code or device already assigned'
    });
  }

  await db.device.update({
    where: { id: d.id },
    data: {
      customerId: u.id,
      claimCodeHash: null
    }
  });

  res.json({
    claimed: true,
    deviceId: d.deviceId
  });
});

// WATER CONSUMPTION

app.get('/api/consumption', auth, async (req, res) => {
  const u = (req as any).user;

  const where: any = u.role === 'CUSTOMER'
    ? { customerId: u.id }
    : {
        organization: {
          members: { some: { userId: u.id } }
        }
      };

  const ds = await db.device.findMany({
    where,
    select: {
      id: true,
      deviceId: true,
      name: true,
      kind: true,
      building: { select: { name: true } }
    }
  });

  const ids = ds.map(x => x.id);

  const rows = await db.telemetry.findMany({
    where: {
      deviceId: { in: ids },
      receivedAt: {
        gte: new Date(Date.now() - 30 * 864e5)
      }
    },
    orderBy: { receivedAt: 'asc' }
  });

  res.json({
    devices: ds.map(d => ({
      deviceId: d.deviceId,
      name: d.name,
      kind: d.kind,
      building: d.building?.name,
      readings: rows
        .filter(x => x.deviceId === d.id)
        .map(x => ({
          time: x.receivedAt,
          litres: x.cumulativeLitres,
          flowLpm: x.flowLpm
        }))
    }))
  });
});

// REPORTS

app.get('/api/reports/:deviceId/history', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  res.json(await db.report.findMany({
    where: { deviceId: d.id },
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true
    },
    orderBy: { createdAt: 'desc' }
  }));
});

app.get('/api/reports/:deviceId/history/:reportId/pdf', auth, async (req, res) => {
  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (
    !d ||
    !await canAccessDevice((req as any).user, d)
  ) {
    return res.sendStatus(404);
  }

  const r = await db.report.findFirst({
    where: {
      id: String(req.params.reportId),
      deviceId: d.id
    }
  });

  if (!r?.filePath) {
    return res.status(404).json({
      error: 'A saved background report is not available for this period.'
    });
  }

  res.download(
    r.filePath,
    `${d.deviceId}-weekly-${r.periodStart.toISOString().slice(0, 10)}.pdf`
  );
});

app.get('/api/reports/:deviceId/pdf', auth, async (req, res) => {
  const u = (req as any).user;

  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (!d || !await canAccessDevice(u, d)) {
    return res.sendStatus(404);
  }

  const from = new Date(Date.now() - 7 * 864e5);
  const to = new Date();

  const [readings, alerts, maintenance] = await Promise.all([
    db.telemetry.findMany({
      where: {
        deviceId: d.id,
        receivedAt: { gte: from }
      },
      orderBy: { receivedAt: 'asc' }
    }),
    db.alert.findMany({
      where: {
        deviceId: d.id,
        createdAt: { gte: from }
      },
      orderBy: { createdAt: 'asc' }
    }),
    db.maintenance.findMany({
      where: {
        deviceId: d.id,
        createdAt: { gte: from }
      },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  await db.report.create({
    data: {
      deviceId: d.id,
      periodStart: from,
      periodEnd: to
    }
  });

  res.setHeader('Content-Type', 'application/pdf');

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${d.deviceId}-weekly-report.pdf"`
  );

  const PDFDocument = (await import('pdfkit')).default;

  const doc = new PDFDocument({ margin: 48 });

  doc.pipe(res);

  doc.fontSize(23)
    .fillColor('#30476b')
    .text('ClearWater · Weekly Purifier Report');

  doc.moveDown(0.3);

  doc.fontSize(11)
    .fillColor('#53657d')
    .text(`Device: ${d.deviceId} — ${d.name}${d.kind === 'DEMO' ? ' · DEMO' : ''}`);

  doc.text(
    `Reporting period: ${from.toLocaleDateString()} to ${to.toLocaleDateString()}`
  );

  doc.text(
    `Generated: ${to.toLocaleString()} · Stored measurements: ${readings.length}`
  );

  doc.moveDown();

  doc.fontSize(15)
    .fillColor('#30476b')
    .text('Telemetry records');

  doc.moveDown(0.4);

  if (readings.length === 0) {
    doc.fontSize(10)
      .fillColor('#555')
      .text('No measurements were recorded during this period. No readings have been fabricated.');
  }

  for (const r of readings) {
    doc.fontSize(9)
      .fillColor('#35435c')
      .text(
        `${r.receivedAt.toISOString()} | TDS ${
          r.tdsPpm != null
            ? r.tdsPpm + ' ppm'
            : r.rawTds != null
              ? r.rawTds + ' ADC raw'
              : '—'
        } | pH ${
          r.ph ?? (r.rawPh != null ? r.rawPh + ' ADC raw' : '—')
        } | Turbidity ${
          r.turbidityNtu != null
            ? r.turbidityNtu + ' NTU'
            : r.rawTurbidity != null
              ? r.rawTurbidity + ' ADC raw'
              : '—'
        } | Flow ${r.flowLpm ?? '—'} L/min | Total ${
          r.cumulativeLitres ?? '—'
        } L | Leak ${r.leakage ? 'YES' : 'No'}`
      );

    if (doc.y > 700) doc.addPage();
  }

  doc.moveDown();

  doc.fontSize(15)
    .fillColor('#30476b')
    .text('Alerts');

  if (!alerts.length) {
    doc.fontSize(10)
      .fillColor('#555')
      .text('No alerts recorded during this period.');
  }

  for (const a of alerts) {
    doc.fontSize(9).text(
      `${a.createdAt.toISOString()} | ${a.severity} | ${a.title} | ${a.value || ''} | ${a.recommendation}`
    );
  }

  doc.moveDown()
    .fontSize(15)
    .fillColor('#30476b')
    .text('Maintenance');

  if (!maintenance.length) {
    doc.fontSize(10)
      .fillColor('#555')
      .text('No maintenance records in this period.');
  }

  for (const m of maintenance) {
    doc.fontSize(9).text(
      `${m.createdAt.toISOString()} | ${m.action} | ${m.notes || ''} | Estimated due: ${m.estimatedDue?.toLocaleDateString() || 'not set'}`
    );
  }

  doc.moveDown()
    .fontSize(9)
    .fillColor('#777')
    .text(
      'Sensor readings alone do not certify water as safe to drink. Raw ADC values are not calibrated engineering measurements.'
    );

  doc.end();
});

app.get('/api/reports/:deviceId', auth, async (req, res) => {
  const u = (req as any).user;

  const d = await db.device.findUnique({
    where: { deviceId: String(req.params.deviceId) }
  });

  if (!d || !await canAccessDevice(u, d)) {
    return res.sendStatus(404);
  }

  const from = new Date(Date.now() - 7 * 864e5);

  const readings = await db.telemetry.findMany({
    where: {
      deviceId: d.id,
      receivedAt: { gte: from }
    },
    orderBy: { receivedAt: 'asc' }
  });

  res.json({
    device: d.deviceId,
    kind: d.kind,
    period: {
      from,
      to: new Date()
    },
    readings: readings.map(x => ({
      ...x,
      sequence: x.sequence?.toString()
    }))
  });
});

// AUTOMATIC DEVICE OFFLINE MONITOR

let lastOfflineMonitorError = 0;

setInterval(async () => {
  try {
    const timeout = Number(
      process.env.DEVICE_OFFLINE_SECONDS || 35
    );

    const cutoff = new Date(Date.now() - timeout * 1000);

    const devices = await db.device.findMany({
      where: {
        kind: DeviceKind.REAL,
        active: true,
        lastSeen: { not: null }
      }
    });

    for (const d of devices) {
      if (d.lastSeen && d.lastSeen < cutoff) {
        if (
          !await db.alert.findFirst({
            where: {
              deviceId: d.id,
              code: 'DEVICE_OFFLINE',
              resolvedAt: null
            }
          })
        ) {
          const a = await db.alert.create({
            data: {
              deviceId: d.id,
              code: 'DEVICE_OFFLINE',
              title: 'Device offline',
              severity: Severity.RED,
              value: d.lastSeen.toISOString(),
              expected: `Heartbeat within ${timeout}s`,
              recommendation: 'Check Wi-Fi, power and API connectivity.'
            }
          });

          await publish(d.deviceId, {
            deviceId: d.deviceId,
            alert: a
          });
        }
      } else {
        await db.alert.updateMany({
          where: {
            deviceId: d.id,
            code: 'DEVICE_OFFLINE',
            resolvedAt: null
          },
          data: { resolvedAt: new Date() }
        });
      }
    }
  } catch (e) {
    if (Date.now() - lastOfflineMonitorError > 60000) {
      console.error(
        'Offline monitor failed; check DATABASE_URL and PostgreSQL.',
        e
      );

      lastOfflineMonitorError = Date.now();
    }
  }
}, 10000);

// GLOBAL ERROR HANDLER

app.use((e: any, _req: any, res: any, _next: any) => {
  console.error(e);

  res.status(500).json({
    error: 'Unexpected server error'
  });
});

// START SERVER

app.listen(port, () => {
  console.log(`ClearWater API listening on :${port}`);
});