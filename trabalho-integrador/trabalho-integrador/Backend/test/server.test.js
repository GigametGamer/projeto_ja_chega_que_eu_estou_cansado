// Testa inicializacao, entrega do frontend e validacoes sem depender do banco.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const vm = require('node:vm');
process.env.SESSION_SECRET ||= 'test-only-session-secret-with-more-than-32-bytes';
const app = require('../src/app');

let server;
let baseUrl;

// Inicia a aplicacao em uma porta temporaria para os testes HTTP.
before(async () => {
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

// Fecha a porta temporaria para que o processo de testes possa terminar.
after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
});

// Confirma que o processo HTTP responde sem exigir conexao com MariaDB.
test('GET /api/health informa que o servidor esta ativo', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
});

test('health do banco informa a causa de falha na conexao', async (t) => {
    const database = require('../src/config/database');
    t.mock.method(database, 'getConnection', async () => {
        const cause = Object.assign(new Error('Plugin de autenticacao nao suportado.'), {
            code: 'ER_AUTHENTICATION_PLUGIN_NOT_SUPPORTED'
        });
        throw Object.assign(new Error('Timeout ao obter conexao do pool.'), {
            code: 'ER_GET_CONNECTION_TIMEOUT',
            cause
        });
    });
    t.mock.method(console, 'error', () => {});

    const response = await fetch(`${baseUrl}/api/health/database`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        status: 'error',
        database: 'disconnected',
        code: 'ER_GET_CONNECTION_TIMEOUT',
        causeCode: 'ER_AUTHENTICATION_PLUGIN_NOT_SUPPORTED'
    });
});

test('front envia chamadas de desenvolvimento local para a API na porta 3000', () => {
    const authScript = fs.readFileSync(
        path.resolve(__dirname, '../../Front/src/scripts/auth.js'),
        'utf8'
    );
    const storeScript = fs.readFileSync(
        path.resolve(__dirname, '../../Front/src/scripts/store.js'),
        'utf8'
    );
    const apiBaseForLocation = ({ port, hostname = 'localhost' }) => vm.runInNewContext(`${authScript}\napiBaseUrl;`, {
        window: { location: { port, protocol: 'http:', hostname } },
        document: { getElementById: () => null }
    });
    const storeApiBaseExpression = storeScript.match(/const apiBaseUrl = ([\s\S]*?);/);
    assert.ok(storeApiBaseExpression, 'A loja deve definir a URL base da API.');
    const storeApiBaseForPort = (port) => vm.runInNewContext(storeApiBaseExpression[1], {
        window: { location: { port, protocol: 'http:', hostname: 'localhost' } }
    });

    assert.equal(apiBaseForLocation({ port: '5500' }), 'http://localhost:3000/api');
    assert.equal(apiBaseForLocation({ port: '5501' }), 'http://localhost:3000/api');
    assert.equal(apiBaseForLocation({ port: '5502' }), 'http://localhost:3000/api');
    assert.equal(apiBaseForLocation({ port: '5500', hostname: '127.0.0.1' }), 'http://127.0.0.1:3000/api');
    assert.equal(apiBaseForLocation({ port: '3000' }), '/api');
    assert.equal(apiBaseForLocation({ port: '443', hostname: 'ecoskin.example' }), '/api');
    assert.equal(storeApiBaseForPort('5500'), 'http://localhost:3000/api');
    assert.equal(storeApiBaseForPort('5501'), 'http://localhost:3000/api');
    assert.equal(storeApiBaseForPort('3000'), '/api');
});

test('Live Server na porta 5500 pode iniciar o preflight do cadastro', async () => {
    const response = await fetch(`${baseUrl}/api/cadastro`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://localhost:5500',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5500');
});

test('Live Server em outra porta local pode enviar POST de login e cadastro para a API', async () => {
    for (const rota of ['/api/login', '/api/cadastro']) {
        const response = await fetch(`${baseUrl}${rota}`, {
            method: 'POST',
            headers: {
                Origin: 'http://localhost:5502',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        assert.equal(response.status, 400, `${rota} deve chegar ao endpoint e validar os campos`);
        assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5502');
    }
});

// Confirma que a pagina inicial do frontend e servida pelo backend.
test('GET / entrega o frontend', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /BioCosmetics/);
});

// Confirma que arquivos CSS estaticos estao disponiveis em /src.
test('GET /src/styles/store.css entrega o estilo da loja', async () => {
    const response = await fetch(`${baseUrl}/src/styles/store.css`);
    assert.equal(response.status, 200);
});

test('CSS do parallax carrega a imagem servida pelo frontend', async () => {
    const cssUrl = `${baseUrl}/src/styles/parallax.css`;
    const cssResponse = await fetch(cssUrl);
    assert.equal(cssResponse.status, 200);

    const css = await cssResponse.text();
    const imagem = css.match(/background-image:\s*url\((['"]?)([^'")]+)\1\)/);
    assert.ok(imagem, 'O CSS deve declarar a imagem do parallax.');

    const imageResponse = await fetch(new URL(imagem[2], cssUrl));
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type'), /^image\/jpeg/);
});

// Confirma que os scripts do frontend estao disponiveis junto com a API.
test('GET /src/scripts/store.js entrega o script da loja', async () => {
    const response = await fetch(`${baseUrl}/src/scripts/store.js`);
    assert.equal(response.status, 200);
});

// Confirma que o login rejeita campos ausentes antes de acessar o banco.
test('POST /api/login sem credenciais retorna HTTP 400', async () => {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST'
    });
    assert.equal(response.status, 400);
});

// Confirma que o cadastro rejeita dados incompletos antes de acessar o banco.
test('POST /api/produtos sem sessao retorna HTTP 401', async () => {
    const response = await fetch(`${baseUrl}/api/produtos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(response.status, 401);
});

// Confirma que JSON invalido recebe resposta 400 em vez de derrubar o servidor.
test('JSON malformado retorna HTTP 400', async () => {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{'
    });
    assert.equal(response.status, 400);
});

// Confirma que as telas de login e cadastro sao servidas pelo backend.
test('GET /pages/login/ e /pages/cadastro/ entregam as telas de acesso', async () => {
    const login = await fetch(`${baseUrl}/pages/login/`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /id="form-login"/);

    const cadastro = await fetch(`${baseUrl}/pages/cadastro/`);
    assert.equal(cadastro.status, 200);
    assert.match(await cadastro.text(), /id="form-cadastro"/);
});

// Confirma que o cadastro rejeita dados incompletos antes de acessar o banco.
test('POST /api/cadastro sem dados retorna HTTP 400', async () => {
    const response = await fetch(`${baseUrl}/api/cadastro`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(response.status, 400);
});

// Confirma que senhas curtas e CPF invalido sao barrados no backend tambem.
test('POST /api/cadastro com senha curta ou CPF invalido retorna HTTP 400', async () => {
    const base = { nome: 'Ana', email: 'ana@teste.com', cpf_cnpj: '12345678901', senha: '12345678' };

    const senhaCurta = await fetch(`${baseUrl}/api/cadastro`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, senha: '123' })
    });
    assert.equal(senhaCurta.status, 400);

    const cpfInvalido = await fetch(`${baseUrl}/api/cadastro`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, cpf_cnpj: '123' })
    });
    assert.equal(cpfInvalido.status, 400);
});

// Confirma que o hash de senha confere a senha certa e recusa a errada.
test('utils/senha gera e confere hashes', () => {
    const { gerarHash, conferirSenha } = require('../src/utils/senha');
    const hash = gerarHash('minhasenha123');
    assert.match(hash, /^scrypt\$/);
    assert.equal(conferirSenha('minhasenha123', hash), true);
    assert.equal(conferirSenha('errada', hash), false);
    assert.equal(conferirSenha('123', '123'), true);
});

test('login migra senha legada para hash sem remover espacos intencionais', async (t) => {
    const AuthModel = require('../src/models/authModel');
    const authController = require('../src/controllers/authController');
    const { conferirSenha } = require('../src/utils/senha');
    let senhaMigrada;

    t.mock.method(AuthModel, 'buscarPorEmail', async () => [{
        id_login: 1,
        id_cliente: 1,
        senha: ' senha legada ',
        ativo: true,
        papel: 'CLIENTE',
        nome: 'Ana'
    }]);
    t.mock.method(AuthModel, 'atualizarSenha', async (idLogin, senhaHash) => {
        assert.equal(idLogin, 1);
        senhaMigrada = senhaHash;
    });
    t.mock.method(AuthModel, 'atualizarUltimoAcesso', async () => {});

    const response = {
        statusCode: null,
        body: null,
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };

    await authController.login({
        body: { email: 'ana@example.com', senha: ' senha legada ' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.match(senhaMigrada, /^scrypt\$/);
    assert.equal(conferirSenha(' senha legada ', senhaMigrada), true);

    const cookie = response.headers['Set-Cookie'];
    assert.match(cookie, /HttpOnly/);
    const token = cookie.match(/ecoskin_session=([^;]+)/)[1];
    const { verificar } = require('../src/middlewares/authSession');
    assert.deepEqual(verificar(token), {
        id_cliente: 1,
        id_login: 1,
        papel: 'CLIENTE'
    });
});

test('sessao invalida e negada e clientes nao podem administrar catalogo', () => {
    const { exigirAutenticacao, exigirAdministrador } = require('../src/middlewares/authSession');
    const resposta = {
        statusCode: null,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json() {
            return this;
        }
    };

    exigirAutenticacao({ headers: {} }, resposta, () => {
        assert.fail('Uma requisicao sem cookie nao deve ser autenticada.');
    });
    assert.equal(resposta.statusCode, 401);

    resposta.statusCode = null;
    exigirAdministrador({ auth: { papel: 'CLIENTE' } }, resposta, () => {
        assert.fail('Um cliente nao deve administrar o catalogo.');
    });
    assert.equal(resposta.statusCode, 403);
});
