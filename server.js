const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Variáveis globais para controle
let isSending = false;
let stopRequested = false;
let emailCount = 0;
let serverStartTime = new Date();

// ========== ROTAS DE STATUS E MONITORAMENTO ==========

// Rota principal da API
app.get('/api', (req, res) => {
  res.json({
    message: '🚀 Servidor de Email Rodrigo Bento',
    version: '1.0.0',
    endpoints: {
      'GET /api': 'Informações da API',
      'GET /status': 'Status do servidor (monitor)',
      'GET /health': 'Health check simples',
      'GET /sending-status': 'Status do envio atual',
      'POST /send-gmail': 'Enviar e-mail via Gmail (completo)',
      'POST /send-gmail-simple': 'Enviar e-mail via Gmail (simplificado)',
      'POST /stop-sending': 'Parar envio em andamento'
    }
  });
});

// Rota de status do servidor para o monitor (SEGURA)
app.get('/status', (req, res) => {
  try {
    const statusData = {
      status: 'online',
      port: process.env.PORT || 3001,
      uptime: process.uptime(),
      startTime: serverStartTime,
      memory: {
        usage: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100) / 100
      },
      emails: {
        today: emailCount,
        total: emailCount
      },
      timestamp: new Date().toISOString()
    };

    res.json(statusData);
  } catch (error) {
    console.error('❌ Erro na rota /status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao obter status do servidor'
    });
  }
});

// Rota de health check simplificada
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Email Server',
    isSending: isSending
  });
});

// Rota para verificar status do envio
app.get('/sending-status', (req, res) => {
  res.json({
    isSending: isSending,
    stopRequested: stopRequested,
    emailCount: emailCount
  });
});

// ========== ROTAS DE CONTROLE ==========

// Rota para parar o envio
app.post('/stop-sending', (req, res) => {
  if (isSending) {
    stopRequested = true;
    console.log('⏹️ Parada de envio solicitada pelo usuário');
    res.json({
      success: true,
      message: 'Parada de envio solicitada. Aguarde...'
    });
  } else {
    res.json({
      success: false,
      message: 'Nenhum envio em andamento'
    });
  }
});

// ========== ROTAS DE EMAIL (PRINCIPAIS) ==========

// ROTA PRINCIPAL: /send-gmail com tratamento completo
app.post('/send-gmail', async (req, res) => {
  console.log('📧 Recebendo solicitação na rota /send-gmail...');
  
  // Verificar se já está enviando
  if (isSending) {
    return res.status(429).json({
      success: false,
      message: 'Já existe um envio em andamento. Aguarde ou cancele o envio atual.'
    });
  }

  // Iniciar controle de envio
  isSending = true;
  stopRequested = false;

  try {
    const { user, password, from, to, subject, text, html, attachments } = req.body;

    // Validações básicas
    if (!user || !password || !to || !subject || !text) {
      isSending = false;
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos. Verifique user, password, to, subject e text.'
      });
    }

    // Configuração do transporter Gmail
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: user,
        pass: password
      },
      debug: false,
      logger: false
    });

    // Configurar opções do e-mail
    const mailOptions = {
      from: from || user,
      to: to,
      subject: subject,
      text: text,
      html: html || text.replace(/\n/g, '<br>')
    };

    // Adicionar anexos se existirem
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        contentType: att.contentType
      }));
    }

    console.log('📤 Enviando e-mail para:', to);

    // Verificar se parada foi solicitada
    if (stopRequested) {
      throw new Error('Envios interrompidos pelo usuário');
    }

    // Verificar a conexão primeiro
    await transporter.verify();

    // Verificar se parada foi solicitada novamente
    if (stopRequested) {
      throw new Error('Envios interrompidos pelo usuário');
    }

    // Enviar e-mail
    const result = await transporter.sendMail(mailOptions);
    
    // Incrementar contador de e-mails
    emailCount++;
    
    console.log('✅ E-mail enviado com sucesso:', result.messageId);
    
    res.json({
      success: true,
      message: 'E-mail enviado com sucesso!',
      messageId: result.messageId,
      emailCount: emailCount
    });

  } catch (error) {
    console.error('❌ Erro ao enviar e-mail:', error);
    
    let errorMessage = 'Erro ao enviar e-mail';
    let shouldWait = false;
    
    if (stopRequested) {
      errorMessage = 'Envios interrompidos pelo usuário';
    } else if (error.code === 'EAUTH') {
      errorMessage = 'Erro de autenticação. Verifique o e-mail e senha de app.';
    } else if (error.code === 'EENVELOPE') {
      errorMessage = 'Erro no envelope do e-mail. Verifique os destinatários.';
    } else if (error.message.includes('Invalid login')) {
      errorMessage = 'Login inválido. Verifique as credenciais do Gmail.';
    } else if (error.message.includes('self signed certificate')) {
      errorMessage = 'Erro de certificado. Tente usar secure: false na configuração.';
    } else if (error.message.includes('quota') || 
               error.message.includes('limit exceeded') || 
               error.message.includes('too many') ||
               error.message.includes('rate limit') ||
               error.code === 'EMAXLIMIT') {
      errorMessage = '📧 Limite diário do Gmail atingido! ⚠️\n\nVocê atingiu o limite de envios do Gmail para hoje.\nPor favor, aguarde até amanhã para continuar enviando e-mails.';
      shouldWait = true;
    } else if (error.message.includes('Message rejected') || 
               error.message.includes('suspicious activity')) {
      errorMessage = '📧 E-mail bloqueado pelo Gmail! ⚠️\n\nO Gmail detectou atividade incomum e bloqueou o envio.\nAguarde algumas horas ou tente novamente amanhã.';
      shouldWait = true;
    } else {
      errorMessage = error.message;
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      shouldWait: shouldWait,
      interrupted: stopRequested
    });

  } finally {
    // Resetar variáveis de controle
    isSending = false;
    stopRequested = false;
  }
});

// ROTA ALTERNATIVA: /send-gmail-simple com configuração mais tolerante
app.post('/send-gmail-simple', async (req, res) => {
  console.log('📧 Recebendo solicitação na rota /send-gmail-simple...');

  // Verificar se já está enviando
  if (isSending) {
    return res.status(429).json({
      success: false,
      message: 'Já existe um envio em andamento. Aguarde ou cancele o envio atual.'
    });
  }

  isSending = true;
  stopRequested = false;

  try {
    const { user, password, to, subject, text, html } = req.body;

    if (!user || !password || !to || !subject || !text) {
      isSending = false;
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos. Verifique user, password, to, subject e text.'
      });
    }

    // Verificar se parada foi solicitada
    if (stopRequested) {
      throw new Error('Envios interrompidos pelo usuário');
    }

    // Configuração mais simples e tolerante
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: user,
        pass: password
      },
      secure: false,
      tls: {
        rejectUnauthorized: false
      }
    });

    const mailOptions = {
      from: user,
      to: to,
      subject: subject,
      text: text,
      html: html || text
    };

    console.log('📤 Enviando e-mail simplificado para:', to);

    // Verificar se parada foi solicitada
    if (stopRequested) {
      throw new Error('Envios interrompidos pelo usuário');
    }

    const result = await transporter.sendMail(mailOptions);
    
    // Incrementar contador de e-mails
    emailCount++;
    
    console.log('✅ E-mail simplificado enviado com sucesso:', result.messageId);
    
    res.json({
      success: true,
      message: 'E-mail enviado com sucesso!',
      messageId: result.messageId,
      emailCount: emailCount
    });

  } catch (error) {
    console.error('❌ Erro ao enviar e-mail simplificado:', error);
    
    let errorMessage = error.message;
    let shouldWait = false;

    if (stopRequested) {
      errorMessage = 'Envios interrompidos pelo usuário';
    } else if (error.message.includes('quota') || 
               error.message.includes('limit exceeded') || 
               error.message.includes('too many') ||
               error.message.includes('rate limit')) {
      errorMessage = '📧 Limite diário do Gmail atingido! ⚠️\n\nVocê atingiu o limite de envios do Gmail para hoje.\nPor favor, aguarde até amanhã para continuar enviando e-mails.';
      shouldWait = true;
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      shouldWait: shouldWait,
      interrupted: stopRequested
    });

  } finally {
    isSending = false;
    stopRequested = false;
  }
});

// ========== ROTA DE FALLBACK ==========

// Rota para qualquer outra requisição
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Rota não encontrada',
    availableRoutes: {
      'GET /api': 'Informações da API',
      'GET /status': 'Status do servidor',
      'GET /health': 'Health check',
      'POST /send-gmail': 'Enviar e-mail completo',
      'POST /send-gmail-simple': 'Enviar e-mail simplificado'
    }
  });
});

// ========== INICIAR SERVIDOR ==========

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 SERVIDOR DE EMAIL RODANDO!');
  console.log('📍 Porta:', PORT);
  console.log('⏰ Iniciado em:', serverStartTime.toLocaleString('pt-BR'));
  console.log('');
  console.log('📧 ENDPOINTS DISPONÍVEIS:');
  console.log('   GET  /api                 - Informações da API');
  console.log('   GET  /status              - Status do servidor (monitor)');
  console.log('   GET  /health              - Health check');
  console.log('   GET  /sending-status      - Status do envio atual');
  console.log('   POST /send-gmail          - Envio completo com anexos');
  console.log('   POST /send-gmail-simple   - Envio simplificado');
  console.log('   POST /stop-sending        - Parar envio em andamento');
  console.log('');
  console.log('👨‍💻 Desenvolvido por: Rodrigo Alves Bento');
  console.log('📞 WhatsApp: (31) 98631-5737');
  console.log('');
});

// ========== TRATAMENTO DE ERROS GLOBAIS ==========

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
  isSending = false;
  stopRequested = false;
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
  isSending = false;
  stopRequested = false;
});

// Tratamento graceful de shutdown
process.on('SIGINT', () => {
  console.log('🛑 Desligando servidor gracefulmente...');
  console.log('📧 Total de e-mails enviados nesta sessão:', emailCount);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Servidor recebeu SIGTERM...');
  console.log('📧 Total de e-mails enviados nesta sessão:', emailCount);
  process.exit(0);
});