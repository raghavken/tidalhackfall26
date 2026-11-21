`timescale 1ns/1ps
// Behavioral Virtual JTAG TAP signals for the mailbox-to-detector test.
module sld_virtual_jtag #(parameter sld_instance_index=0, sld_ir_width=1)(
    output reg tck=0, tdi=0,
    input wire tdo,
    output wire ir_in,
    input wire ir_out,
    output reg virtual_state_cdr=0, virtual_state_sdr=0, virtual_state_udr=0
);
    assign ir_in = 1;
endmodule

module tb_jtag;
    reg clk=0, reset_n=0;
    always #5 clk = ~clk;
    wire [5:0] red;
    wire [7:0] green;
    top dut(clk, reset_n, red, green);

    reg [7:0] bytes [0:58799];
    reg [73:0] expected [0:11];
    reg [127:0] reply;
    reg [55:0] measurement;
    reg [111:0] result;
    reg [7:0] checksum;
    integer i, j, received;

    task tck_pulse;
        begin
            #20 dut.transport.endpoint.tck = 1;
            #20 dut.transport.endpoint.tck = 0;
        end
    endtask

    task scan;
        input [63:0] command;
        integer bit_index;
        begin
            // The real TAP supplies several TCKs between DR scans.
            tck_pulse;
            tck_pulse;
            dut.transport.endpoint.virtual_state_cdr = 1;
            tck_pulse;
            dut.transport.endpoint.virtual_state_cdr = 0;
            dut.transport.endpoint.virtual_state_sdr = 1;
            for (bit_index=0; bit_index<128; bit_index=bit_index+1) begin
                reply[bit_index] = dut.transport.endpoint.tdo;
                dut.transport.endpoint.tdi = bit_index<64 ? command[bit_index] : 1'b0;
                tck_pulse;
            end
            dut.transport.endpoint.virtual_state_sdr = 0;
            dut.transport.endpoint.virtual_state_udr = 1;
            tck_pulse;
            dut.transport.endpoint.virtual_state_udr = 0;
            if (reply[127:120] !== 8'hA7 || reply[114])
                $fatal(1, "Invalid mailbox reply %h", reply);
        end
    endtask

    task send_command;
        input [63:0] command;
        integer attempts;
        begin
            scan(command);
            if (!reply[112]) $fatal(1, "Command mailbox busy for opcode %0d", command[63:56]);
            scan(64'd0);
            for (attempts=0; attempts<10 && !reply[112]; attempts=attempts+1)
                scan(64'd0);
            if (!reply[112]) $fatal(1, "Command did not acknowledge");
        end
    endtask

    initial begin
        $readmemh("build/grid_oscillation.hex", bytes);
        $readmemh("build/grid_oscillation.expected.hex", expected);
        #100 reset_n = 1;
        send_command({8'd2, 56'd0});
        received=0;
        for (i=0; i<8400; i=i+1) begin
            for (j=0; j<7; j=j+1)
                measurement[j*8 +: 8] = bytes[i*7+j];
            send_command({8'd1, measurement});
            if ((i+1)%2400==0) begin
                repeat(4) begin
                    scan(64'd0);
                    if (!reply[113]) scan(64'd0);
                    if (!reply[113]) $fatal(1, "Missing result %0d", received);
                    result = reply[111:0];
                    checksum = 0;
                    for (j=0; j<13; j=j+1) checksum = checksum + result[j*8 +: 8];
                    if (result[7:0] !== 8'h55 || result[111:104] !== checksum ||
                        {result[9:8],result[31:16],result[86:32],result[96]} !== expected[received])
                        $fatal(1, "Result %0d mismatch, packet %h", received, result);
                    received = received + 1;
                    send_command({8'd3, 56'd0});
                end
            end
        end
        scan(64'd0);
        if (reply[113] || received!=12 || red[4] || !red[5])
            $fatal(1, "Unexpected final mailbox or LED state");
        $display("PASS Virtual JTAG mailbox, 8400 measurements and 12 exact results");
        $finish;
    end
endmodule
