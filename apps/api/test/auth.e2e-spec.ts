import request from 'supertest';
import { TestContext, createTestApp, createUser } from './utils';

describe('Auth (e2e)', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let doctor: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx, 'ADMIN');
    doctor = await createUser(ctx, 'DOCTOR');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());

  it('logs in with correct credentials', async () => {
    const res = await http().post('/auth/login').send({ email: admin.user.email, password: admin.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ id: admin.user.id, role: 'ADMIN', isGuest: false });
  });

  it('rejects a wrong password and an unknown email with the same error', async () => {
    const wrong = await http().post('/auth/login').send({ email: admin.user.email, password: 'nope' });
    const unknown = await http().post('/auth/login').send({ email: 'nobody@clinic.test', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('validates the login body', async () => {
    const res = await http().post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('issues an anonymous patient token', async () => {
    const guest = await http().post('/auth/guest');
    expect(guest.status).toBe(200);
    const me = await http().get('/auth/me').set('Authorization', `Bearer ${guest.body.accessToken}`);
    expect(me.body).toMatchObject({ role: 'PATIENT', isGuest: true });
  });

  it('requires a token on protected routes', async () => {
    expect((await http().get('/users')).status).toBe(401);
    expect((await http().get('/users').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('enforces roles', async () => {
    expect((await http().get('/users').set('Authorization', `Bearer ${doctor.token}`)).status).toBe(403);
    const ok = await http().get('/users').set('Authorization', `Bearer ${admin.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body[0]).not.toHaveProperty('passwordHash');
  });

  it('serves public routes without a token', async () => {
    expect((await http().get('/health')).body.status).toBe('ok');
    expect((await http().get('/doctors')).status).toBe(200);
  });
});
